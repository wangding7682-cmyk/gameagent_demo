/**
 * 【全局唯一事件总线】所有模块的通信核心
 */
export class EventBus {
    constructor() {
        // 实现单例模式，保证全局唯一
        if (EventBus.instance) {
            return EventBus.instance;
        }
        this.events = {};
        EventBus.instance = this;
    }

    /**
     * 监听事件
     * @param {string} event 事件名
     * @param {Function} callback 回调函数
     */
    on(event, callback) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(callback);
    }

    /**
     * 触发事件
     * @param {string} event 事件名
     * @param {any} data 传递的数据
     */
    emit(event, data) {
        if (this.events[event]) {
            this.events[event].forEach(callback => callback(data));
        }
    }

    /**
     * 取消监听
     * @param {string} event 事件名
     * @param {Function} callback 回调函数
     */
    off(event, callback) {
        if (this.events[event]) {
            this.events[event] = this.events[event].filter(cb => cb !== callback);
        }
    }
}

// 导出一个默认的全局单例实例，供各个业务模块直接引入使用
export const globalEventBus = new EventBus();