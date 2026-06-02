/**
 * 底座逻辑：模式切换、全局状态管理
 */
export class App {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.state = {
            currentMode: 'default'
        };
    }

    init() {
        console.log('App initialized');
        // 初始化逻辑预留
    }

    setMode(mode) {
        this.switchMode(mode);
    }

    switchMode(mode) {
        if (this.state.currentMode === mode) {
            console.log('[App] switchMode 被忽略，目标模式与当前模式一致:', mode);
            return;
        }
        console.log('[App] switchMode 被调用，切换到模式:', mode);
        this.state.currentMode = mode;
        this.eventBus.emit('MODE_CHANGED', mode);
        this.eventBus.emit('modeChanged', mode);
        console.log(`[App] Mode switched to: ${mode}`);
    }
}
