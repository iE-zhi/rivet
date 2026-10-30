/** 本机 UI 验证用 RFB3.8 假服务器；仅监听 loopback，无认证，禁止用于真实桌面。 */
import net from "node:net";

/** 测试桌面为 640×360 像素；总帧和输入缓冲均有固定上限。 */
const WIDTH = 640,
  HEIGHT = 360;
/** 输入反馈只更新对角两块 16×16 像素，验证多区域 IPC 不传输中间的静止桌面。 */
const PATCH_SIZE = 16;
/** RFB 矩形头为十二字节，包含坐标、尺寸和四字节编码标识。 */
const RECT_HEADER_BYTES = 12;
/** 每条测试连接最多闲置两分钟，整个夹具最多存活十分钟。 */
const IDLE_TIMEOUT_MS = 120_000,
  LIFETIME_MS = 600_000;
/** 输入积压最多十六 KiB，超过则关闭该假连接。 */
const MAX_BUFFER_BYTES = 16_384;
/** 最多接收四个验证桌面，与生产会话上限一致。 */
const MAX_CLIENTS = 4;
/** 当前假服务端拥有的 socket 集合，关闭时全部释放，最多四个元素。 */
const clients = new Set();

/** counter 为零生成完整渐变桌面，大于零仅返回对角变化区域；像素使用 RGBA。 */
function frame(counter) {
  if (counter > 0) {
    const bytes = Buffer.alloc(
      4 + 2 * (RECT_HEADER_BYTES + PATCH_SIZE * PATCH_SIZE * 4),
    );
    bytes.writeUInt16BE(2, 2);
    let offset = 4;
    for (const [x, y] of [
      [0, 0],
      [WIDTH - PATCH_SIZE, HEIGHT - PATCH_SIZE],
    ]) {
      bytes.writeUInt16BE(x, offset);
      bytes.writeUInt16BE(y, offset + 2);
      bytes.writeUInt16BE(PATCH_SIZE, offset + 4);
      bytes.writeUInt16BE(PATCH_SIZE, offset + 6);
      offset += RECT_HEADER_BYTES;
      for (let pixel = 0; pixel < PATCH_SIZE * PATCH_SIZE; pixel++) {
        bytes.set([(counter * 40) % 255, 180, 130, 255], offset);
        offset += 4;
      }
    }
    return bytes;
  }
  const bytes = Buffer.alloc(16 + WIDTH * HEIGHT * 4);
  bytes.writeUInt16BE(1, 2);
  bytes.writeUInt16BE(WIDTH, 8);
  bytes.writeUInt16BE(HEIGHT, 10);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const offset = 16 + (y * WIDTH + x) * 4;
      bytes[offset] =
        y < 24 ? (counter * 40) % 255 : Math.floor((x * 255) / WIDTH);
      bytes[offset + 1] = y < 24 ? 180 : Math.floor((y * 255) / HEIGHT);
      bytes[offset + 2] = 130;
      bytes[offset + 3] = 255;
    }
  return bytes;
}

/** 每个 socket 拥有自己的有限输入缓冲与握手状态；结束后从集合释放。 */
const server = net.createServer((socket) => {
  if (clients.size >= MAX_CLIENTS) {
    socket.destroy();
    return;
  }
  clients.add(socket);
  let buffer = Buffer.alloc(0),
    stage = "version",
    counter = 0,
    pending = false,
    dirty = true;
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  socket.on("error", (error) =>
    process.stderr.write(`fixture socket: ${error.message}\n`),
  );
  socket.on("close", () => clients.delete(socket));
  socket.write("RFB 003.008\n");

  /** 一次只发送一个请求对应的最新桌面；高水位时由 TCP 自身背压约束。 */
  const update = () => {
    if (!pending || !dirty || socket.writableLength > WIDTH * HEIGHT * 4)
      return;
    pending = false;
    dirty = false;
    socket.write(frame(counter));
  };

  /** 解析有界的完整消息；不完整消息保留到下一次 data，不重复消费。 */
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > MAX_BUFFER_BYTES) {
      socket.destroy(new Error("fixture input limit"));
      return;
    }
    while (buffer.length) {
      let length = 0;
      if (stage === "version") {
        if (buffer.length < 12) return;
        if (buffer.subarray(0, 12).toString() !== "RFB 003.008\n") {
          socket.destroy();
          return;
        }
        length = 12;
        stage = "security";
        socket.write(Buffer.from([1, 1]));
      } else if (stage === "security") {
        if (buffer[0] !== 1) {
          socket.destroy();
          return;
        }
        length = 1;
        stage = "init";
        socket.write(Buffer.alloc(4));
      } else if (stage === "init") {
        length = 1;
        stage = "messages";
        const init = Buffer.alloc(24);
        init.writeUInt16BE(WIDTH);
        init.writeUInt16BE(HEIGHT, 2);
        Buffer.from([
          32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
        ]).copy(init, 4);
        init.writeUInt32BE(11, 20);
        socket.write(Buffer.concat([init, Buffer.from("VNC fixture")]));
      } else {
        const type = buffer[0];
        if (type === 0) length = 20;
        else if (type === 2) {
          if (buffer.length < 4) return;
          length = 4 + buffer.readUInt16BE(2) * 4;
        } else if (type === 3) length = 10;
        else if (type === 4) length = 8;
        else if (type === 5) length = 6;
        else {
          socket.destroy(new Error(`unsupported fixture message ${type}`));
          return;
        }
        if (buffer.length < length) return;
        if (type === 3) pending = true;
        if (type === 4 || type === 5) {
          counter += 1;
          dirty = true;
          process.stdout.write(
            JSON.stringify(
              type === 4
                ? { key: buffer.readUInt32BE(4), down: buffer[1] }
                : {
                    pointer: [buffer.readUInt16BE(2), buffer.readUInt16BE(4)],
                    buttons: buffer[1],
                  },
            ) + "\n",
          );
        }
      }
      buffer = buffer.subarray(length);
      update();
    }
  });
});

/** 正常结束会释放监听端口与所有测试 socket，避免留驻后台服务。 */
function stop() {
  for (const client of clients) client.destroy();
  server.close();
}
server.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
  stop();
});
server.listen(0, "127.0.0.1", () =>
  process.stdout.write(`VNC fixture: 127.0.0.1:${server.address().port}\n`),
);
const deadline = setTimeout(stop, LIFETIME_MS);
server.on("close", () => clearTimeout(deadline));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
