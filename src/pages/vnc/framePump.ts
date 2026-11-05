/** VNC 取帧调度：每个桌面只保留一个请求或待绘制响应，在绘制间隔内传输像素。 */

/** 界面线程独占的桌面调度器；隐藏暂停，恢复时用完整帧重建画布。 */
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
  /** 同步消费当前响应；回调结束后无需保留该像素缓冲。 */
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

  /** active 为可见状态；隐藏取消待绘制的响应，恢复时重新读取完整像素。 */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      this.full = true;
      void this.poll();
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

  /** 在可见时读取一个响应，绘制后立即发起下一次读取；任何失败终止调度。 */
  private async poll(): Promise<void> {
    if (
      !this.active ||
      this.disposed ||
      this.running ||
      this.animation !== null
    )
      return;
    this.running = true;
    const full = this.full;
    this.full = false;
    try {
      const buffer = await this.read(full);
      if (!this.active || this.disposed) return;
      this.animation = requestAnimationFrame(
        /** buffer 只保留到当前绘制时钟；同步消费后才允许读取下一帧。 */ () => {
          this.animation = null;
          try {
            this.present(buffer);
          } catch (error) {
            this.dispose();
            this.failed(error);
            return;
          }
          void this.poll();
        },
      );
    } catch (error) {
      if (!this.disposed) {
        this.dispose();
        this.failed(error);
      }
    } finally {
      this.running = false;
    }
  }
}
