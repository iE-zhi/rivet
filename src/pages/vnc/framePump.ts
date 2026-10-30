/** VNC 取帧调度：同一桌面只保留一个请求，按显示器绘制节奏读取最新变化。 */

/** 界面线程独占的桌面调度器；隐藏停止后续请求，销毁丢弃迟到响应，不持有像素队列。 */
export class VncFramePump {
  /** 当前桌面是否可见；恢复可见时请求完整帧。 */
  private active = false;
  /** 销毁后不再绘制、调度或报告迟到错误。 */
  private disposed = false;
  /** 在途请求归本实例独占，暂停和恢复不能创建第二个请求。 */
  private running = false;
  /** 下一个请求是否需要重建完整 Canvas，初始和恢复显示时为 true。 */
  private full = true;
  /** 尚未执行的绘制回调 ID，null 表示没有回调。 */
  private animation: number | null = null;
  /** 串行读取回调，返回的响应仅交给 present。 */
  private readonly read: (full: boolean) => Promise<ArrayBuffer>;
  /** 同步绘制回调，不在实例中保留像素引用。 */
  private readonly present: (buffer: ArrayBuffer) => void;
  /** 会话失败回调，负责向用户报告并关闭协议资源。 */
  private readonly failed: (error: unknown) => void;

  /** read 接收完整帧标志；present 同步消费响应；failed 接收读取或绘制异常并关闭会话。 */
  constructor(
    read: (full: boolean) => Promise<ArrayBuffer>,
    present: (buffer: ArrayBuffer) => void,
    failed: (error: unknown) => void,
  ) {
    this.read = read;
    this.present = present;
    this.failed = failed;
  }

  /** active 为可见状态；隐藏取消待执行回调，在途响应仍绘制以保留已消费的变化。 */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      this.full = true;
      this.schedule();
    } else if (this.animation !== null) {
      cancelAnimationFrame(this.animation);
      this.animation = null;
    }
  }

  /** 幂等停止调度；在途 IPC 最多等待后端超时，返回后不再访问已卸载的 Canvas。 */
  dispose(): void {
    this.disposed = true;
    this.active = false;
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.animation = null;
  }

  /** 可见、无在途请求时安排一次绘制回调；回调只发起一个串行读取任务。 */
  private schedule(): void {
    if (
      !this.active ||
      this.disposed ||
      this.running ||
      this.animation !== null
    )
      return;
    this.animation = requestAnimationFrame(
      /** 绘制时钟仅触发本桌面的下一次读取。 */ () => {
        this.animation = null;
        void this.poll();
      },
    );
  }

  /** 读取后立即绘制，再等待下一次绘制时钟；失败停止调度，隐藏时不追加读取。 */
  private async poll(): Promise<void> {
    this.running = true;
    const full = this.full;
    this.full = false;
    try {
      const buffer = await this.read(full);
      if (!this.disposed) this.present(buffer);
    } catch (error) {
      if (!this.disposed) {
        this.dispose();
        this.failed(error);
      }
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}
