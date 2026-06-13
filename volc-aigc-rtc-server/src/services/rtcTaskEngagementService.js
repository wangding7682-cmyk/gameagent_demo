const CANCEL_BRANCH_REGEX = /(不要|不用了?|没必要|别找了|算了|不看了|不吃啦|自己可以|不用找了|别说了|别整了)/;
const PAUSE_BRANCH_REGEX = /(先不用|先不看|先停一下|先停|暂停一下|暂停|回头再说|稍后再说|先这样)/;
const RESUME_BRANCH_REGEX = /(继续|接着|还是看|还是按|还是说|还是围绕|再说|继续说这个|继续看|刚才那个|那个视频呢|那个呢|这波呢|再补一句)/;
const ACK_ONLY_REGEX = /^(嗯+|哦+|啊+|哎+|哈+|哈哈+|哈哈哈+|挺好|没错|好的?|行|可以|对|是的|好辣|非常|好吧|好呀)$/;
const TASK_CUE_REGEX = /(视频|集锦|高光|教学|打法|出装|连招|控龙|接龙|河道|线权|刷野|入侵|对线|团战|知识卡片|战术卡|攻略|节奏)/;

function trimText(value = '', maxLength = 32) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeState(value = '') {
  const state = String(value || '').trim().toLowerCase();
  if (['active', 'paused', 'cancelled', 'light_chat', 'resumable'].includes(state)) {
    return state;
  }
  return 'active';
}

function isRtcSource(source = '') {
  const normalized = String(source || '').trim().toLowerCase();
  return normalized.startsWith('rtc_');
}

function pickPreviousBranchHint(dynamicContext = {}) {
  return trimText(
    dynamicContext.last_resumable_branch ||
      dynamicContext.active_branch_hint ||
      dynamicContext.active_branch_key ||
      '',
    32
  );
}

export function deriveRtcControlSignal(text = '', previousDynamicContext = {}) {
  const normalizedText = String(text || '').trim();
  const previousState = normalizeState(previousDynamicContext?.task_engagement_state);
  const hasPreviousBranch = Boolean(pickPreviousBranchHint(previousDynamicContext));

  if (!normalizedText) {
    return { controlSignal: 'none', nextState: previousState, confidence: 0 };
  }

  if (CANCEL_BRANCH_REGEX.test(normalizedText)) {
    return {
      controlSignal: 'cancel_branch',
      nextState: 'cancelled',
      confidence: 0.95,
    };
  }

  if (PAUSE_BRANCH_REGEX.test(normalizedText)) {
    return {
      controlSignal: 'pause_branch',
      nextState: 'paused',
      confidence: 0.92,
    };
  }

  if (RESUME_BRANCH_REGEX.test(normalizedText)) {
    return {
      controlSignal: hasPreviousBranch || previousState !== 'active' ? 'resume_branch' : 'continue_branch',
      nextState: 'active',
      confidence: 0.9,
    };
  }

  if (ACK_ONLY_REGEX.test(normalizedText)) {
    return {
      controlSignal: 'ack_only',
      nextState: 'light_chat',
      confidence: 0.88,
    };
  }

  if (TASK_CUE_REGEX.test(normalizedText)) {
    return {
      controlSignal: previousState === 'paused' || previousState === 'cancelled' || previousState === 'light_chat'
        ? 'resume_branch'
        : 'continue_branch',
      nextState: 'active',
      confidence: 0.78,
    };
  }

  return {
    controlSignal: 'none',
    nextState: previousState,
    confidence: 0.4,
  };
}

export function deriveTaskEngagementContext({
  userQuery = '',
  source = '',
  previousDynamicContext = {},
  incomingContext = {},
} = {}) {
  const nextContext = {
    ...(incomingContext && typeof incomingContext === 'object' ? incomingContext : {}),
  };

  if (!isRtcSource(source) || !String(userQuery || '').trim()) {
    return nextContext;
  }

  const previousState = normalizeState(previousDynamicContext?.task_engagement_state);
  const previousBranchHint = pickPreviousBranchHint(previousDynamicContext);
  const previousBranchType = String(
    previousDynamicContext?.last_resumable_branch_type || previousDynamicContext?.active_branch_type || ''
  ).trim();
  const derived = deriveRtcControlSignal(userQuery, previousDynamicContext);

  nextContext.last_user_control_signal = derived.controlSignal;
  nextContext.task_engagement_state = derived.nextState;

  if (previousBranchHint) {
    nextContext.last_resumable_branch = previousBranchHint;
  }
  if (previousBranchType) {
    nextContext.last_resumable_branch_type = previousBranchType;
  }

  if (derived.controlSignal === 'cancel_branch') {
    nextContext.branch_cancelled_reason = 'user_declined';
    nextContext.active_branch_type = 'none';
    nextContext.active_branch_key = '';
    nextContext.active_branch_hint = '';
    return nextContext;
  }

  if (derived.controlSignal === 'pause_branch' || derived.controlSignal === 'ack_only') {
    nextContext.active_branch_type = 'none';
    nextContext.active_branch_key = '';
    nextContext.active_branch_hint = '';
    return nextContext;
  }

  if (derived.controlSignal === 'resume_branch') {
    nextContext.branch_cancelled_reason = '';
    if (previousBranchType) {
      nextContext.active_branch_type = previousBranchType;
    }
    if (previousBranchHint) {
      nextContext.active_branch_hint = previousBranchHint;
      nextContext.active_branch_key = `${previousBranchType || 'branch'}:${previousBranchHint}`;
    }
    return nextContext;
  }

  if (derived.controlSignal === 'continue_branch' && previousState !== 'active') {
    nextContext.branch_cancelled_reason = '';
  }

  return nextContext;
}

export function buildActiveBranchContext({
  intent = '',
  stickyHero = '',
  branchHint = '',
  previousDynamicContext = {},
} = {}) {
  const normalizedIntent = String(intent || '').trim();
  const compactHint = trimText(branchHint || '', 32);
  if (!normalizedIntent || !compactHint) {
    return {};
  }

  const previousSignal = String(previousDynamicContext?.last_user_control_signal || '').trim();
  const keepResumeSignal = previousSignal === 'resume_branch';
  const normalizedHero = trimText(stickyHero || '', 10);
  const finalHint = trimText(compactHint || normalizedHero || normalizedIntent, 32);

  return {
    task_engagement_state: 'active',
    last_user_control_signal: keepResumeSignal ? 'resume_branch' : 'continue_branch',
    active_branch_type: normalizedIntent,
    active_branch_key: `${normalizedIntent}:${finalHint}`,
    active_branch_hint: finalHint,
    last_resumable_branch: finalHint,
    last_resumable_branch_type: normalizedIntent,
    branch_cancelled_reason: '',
  };
}

export function getResumableBranchHint(dynamicContext = {}) {
  return pickPreviousBranchHint(dynamicContext);
}
