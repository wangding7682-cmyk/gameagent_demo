import { runAgentOrchestration } from './agentOrchestratorService.js';
import {
  markOrchestrationRunning,
  markOrchestrationDone,
  appendSessionEvent,
  appendTtsTextSent,
} from './rtcLlmBridgeService.js';

function createChunkId() {
  return `chatcmpl-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function writeOpenAiSseChunk(response, id, content, options = {}) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: options.roleOnly
          ? { role: 'assistant' }
          : options.finish
            ? {}
            : { content },
        finish_reason: options.finish ? 'stop' : null,
      },
    ],
    model: 'game-ai-agent',
    created: Math.floor(Date.now() / 1000),
  };
  if (options.finish) {
    chunk.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeOpenAiSseDone(response) {
  response.write('data: [DONE]\n\n');
}

function stripBracketDescriptions(text = '') {
  return String(text)
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMainReplySpeech(data = {}) {
  const intent = data.intent || 'smalltalk';
  const isImageCard = data.popup_mode === 'strategy_card' || data.needs_image === true;

  const emotional = data.emotional_reply || '';
  const understanding = data.understanding_reply || '';
  const branchWait = data.branch_wait_reply || '';
  const mainSummary = data.main_summary || '';

  let parts = [];
  let branch = '';

  if (intent === 'strategy') {
    if (isImageCard) {
      branch = 'strategy(card_with_image)';
      parts = [emotional, understanding, branchWait].filter(Boolean);
    } else {
      branch = 'strategy(text_only)';
      parts = [emotional, mainSummary].filter(Boolean);
    }
  } else if (intent === 'video') {
    branch = 'video';
    parts = [emotional, understanding, branchWait].filter(Boolean);
  } else {
    branch = 'smalltalk';
    parts = [emotional, mainSummary].filter(Boolean);
  }

  const speech = stripBracketDescriptions(parts.join(' '));

  console.log(`[RtcLlmBridge:buildMainReplySpeech] branch=${branch} | intent=${intent} isImageCard=${isImageCard}`);
  console.log(`[RtcLlmBridge:buildMainReplySpeech]   emotional_reply    = "${emotional}"`);
  console.log(`[RtcLlmBridge:buildMainReplySpeech]   understanding_reply= "${understanding}"`);
  console.log(`[RtcLlmBridge:buildMainReplySpeech]   branch_wait_reply  = "${branchWait}"`);
  console.log(`[RtcLlmBridge:buildMainReplySpeech]   main_summary       = "${mainSummary}"`);
  console.log(`[RtcLlmBridge:buildMainReplySpeech]   => TTS speech      = "${speech}"`);

  return speech;
}

function isSpeakableVoiceDelta(data = {}) {
  if (data.speakable === false) return false;
  const source = String(data.source || '');
  if (source === 'strategy_chunk') return false;
  if (source === 'smalltalk_summary') return false;
  if (source === 'branch_wait_reply') return false;
  const text = stripBracketDescriptions(data.text || '');
  return text.length > 0;
}

export async function handleRtcLlmStream(body, response, sessionId) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const userQuery = String(lastUserMessage?.content || '').trim();

  console.log(`[RtcLlmBridge] === CustomLLM request === sessionId=${sessionId} userQuery="${userQuery}"`);

  if (!userQuery) {
    console.warn('[RtcLlmBridge] empty user query, sending fallback');
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const id = createChunkId();
    writeOpenAiSseChunk(response, id, '', { roleOnly: true });
    writeOpenAiSseChunk(response, id, '我没有听清，请再说一次。');
    writeOpenAiSseChunk(response, id, '', { finish: true });
    writeOpenAiSseDone(response);
    response.end();
    return;
  }

  const orchestrationBody = {
    text: userQuery,
    orchestrationInput: userQuery,
    rawAsrText: userQuery,
    source: 'rtc_asr',
    sessionId: sessionId || 'default',
  };

  markOrchestrationRunning(sessionId || 'default');

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const chunkId = createChunkId();
  writeOpenAiSseChunk(response, chunkId, '', { roleOnly: true });

  let mainReplyEmitted = false;
  let ttsChunkCount = 0;
  const startedAt = Date.now();

  try {
    await runAgentOrchestration(orchestrationBody, (event, data = {}) => {
      appendSessionEvent(sessionId || 'default', { event, data });

      if (event === 'main_reply' && !mainReplyEmitted) {
        mainReplyEmitted = true;
        const speech = buildMainReplySpeech(data);
        if (speech) {
          ttsChunkCount++;
          const latency = Date.now() - startedAt;
          console.log(`[RtcLlmBridge:TTS] chunk#${ttsChunkCount} (main_reply) latency=${latency}ms | speech="${speech}"`);
          writeOpenAiSseChunk(response, chunkId, speech);
          appendTtsTextSent(sessionId || 'default', speech);
        } else {
          console.warn('[RtcLlmBridge:TTS] main_reply speech is empty after buildMainReplySpeech', {
            intent: data.intent,
            emotional_reply: data.emotional_reply,
            understanding_reply: data.understanding_reply,
            branch_wait_reply: data.branch_wait_reply,
            main_summary: data.main_summary,
          });
        }
      }

      if (event === 'voice_delta') {
        const source = String(data.source || '');
        const speakable = isSpeakableVoiceDelta(data);
        console.log(`[RtcLlmBridge:voice_delta] source="${source}" speakable=${speakable} mainReplyEmitted=${mainReplyEmitted} text="${stripBracketDescriptions(data.text || '')}"`);

        if (mainReplyEmitted && speakable) {
          const text = stripBracketDescriptions(data.text || '');
          if (text) {
            ttsChunkCount++;
            console.log(`[RtcLlmBridge:TTS] chunk#${ttsChunkCount} (voice_delta/${source}) | text="${text}"`);
            writeOpenAiSseChunk(response, chunkId, text);
            appendTtsTextSent(sessionId || 'default', text);
          }
        }
      }

      if (event === 'fsm_state') {
        console.log(`[RtcLlmBridge:fsm_state] intent=${data.intent} state=${data.fsm_state} message="${data.message || ''}"`);
      }

      if (event === 'strategy_ready' || event === 'card_ready' || event === 'video_ready') {
        console.log(`[RtcLlmBridge] ${event} task_id=${data.task_id}`);
      }
    });

    const totalLatency = Date.now() - startedAt;
    console.log(`[RtcLlmBridge] === orchestration done === totalLatency=${totalLatency}ms ttsChunks=${ttsChunkCount}`);
    writeOpenAiSseChunk(response, chunkId, '', { finish: true });
    writeOpenAiSseDone(response);
  } catch (error) {
    console.error('[RtcLlmBridge] orchestration failed:', error);
    if (!mainReplyEmitted) {
      console.warn('[RtcLlmBridge:TTS] sending error fallback speech');
      writeOpenAiSseChunk(response, chunkId, '抱歉，处理遇到了问题，请稍后再试。');
    }
    writeOpenAiSseChunk(response, chunkId, '', { finish: true });
    writeOpenAiSseDone(response);
  } finally {
    markOrchestrationDone(sessionId || 'default');
    response.end();
  }
}
