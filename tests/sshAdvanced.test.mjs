/** 非敏感 SSH 配置的保存、转发校验及跳板引用测试，不访问网络或用户凭据。 */
import assert from "node:assert/strict";
import test from "node:test";
import { areSshForwardRules, isSshHost, MAX_SSH_FORWARD_RULES, MAX_SSH_JUMP_HOSTS, resolveSshJumpChain } from "../src/pages/sshAdvanced.ts";
import { deserializeTerminalConnections, serializeTerminalConnections } from "../src/pages/terminalConnections.ts";

/** 非敏感 SSH 记录基准，所有测试均使用不可联网的示例域名。 */
const CONNECTION = { id: "target", kind: "ssh", name: "Target", group: "SSH", host: "example.invalid", port: 22, username: "test", authType: "password", keyPath: "", x11: false };
/** 合法本地转发基准，默认只监听回环。 */
const LOCAL = { id: "local", kind: "local", bindAddress: "127.0.0.1", bindPort: 8080, targetHost: "example.invalid", targetPort: 80 };

/** 三种首因素和高级配置经过保存/恢复后不泄露外部对象夹带的秘密。 */
test("advanced SSH persistence preserves all authentication modes and strips secrets", () => {
  for (const authType of ["password", "privateKey", "agent"]) {
    const connection = { ...CONNECTION, authType, jumpConnectionId: "gateway", forwards: [{ ...LOCAL, password: "forward-secret" }], password: "connection-secret", responses: ["one-time-secret"] };
    const json = serializeTerminalConnections([connection]);
    assert.equal(json.includes("secret"), false);
    const [restored] = deserializeTerminalConnections(json);
    assert.equal(restored.authType, authType);
    assert.equal(restored.jumpConnectionId, "gateway");
    assert.deepEqual(restored.forwards, [LOCAL]);
  }
});

/** 已移除的认证类型不能恢复或保存，不转换成其他认证方式。 */
test("removed interactive authentication is rejected instead of migrated", () => {
  const removed = { ...CONNECTION, authType: "keyboardInteractive" };
  assert.deepEqual(deserializeTerminalConnections(JSON.stringify([removed])), []);
  assert.throws(() => serializeTerminalConnections([removed]), /Invalid terminal connection/);
});

/** 动态方向无固定目标；同机本地/动态监听冲突、重复 ID 和越界端口被拒绝。 */
test("forward validation rejects conflicting and malformed listeners", () => {
  assert.equal(isSshHost("中".repeat(85)), true);
  assert.equal(isSshHost("中".repeat(86)), false);
  assert.equal(isSshHost("host\u0080"), false);
  const dynamic = { ...LOCAL, id: "dynamic", kind: "dynamic", targetHost: "", targetPort: 0 };
  assert.equal(areSshForwardRules([dynamic]), true);
  assert.equal(areSshForwardRules([LOCAL, dynamic]), false);
  assert.equal(areSshForwardRules([LOCAL, { ...LOCAL, id: "remote", kind: "remote" }]), true);
  for (const malformed of [{ bindPort: 0 }, { bindPort: 65536 }, { bindPort: 1.5 }, { bindAddress: "" }, { bindAddress: "bad\naddress" }, { targetHost: "bad host" }, { targetPort: 0 }, { kind: "unknown" }]) {
    assert.equal(areSshForwardRules([{ ...LOCAL, ...malformed }]), false);
    assert.deepEqual(deserializeTerminalConnections(JSON.stringify([{ ...CONNECTION, forwards: [{ ...LOCAL, ...malformed }] }])), []);
  }
  assert.equal(areSshForwardRules([{ ...dynamic, targetHost: "example.invalid" }]), false);
  assert.equal(areSshForwardRules([LOCAL, { ...LOCAL, bindPort: 8081 }]), false);
  assert.equal(areSshForwardRules(Array.from({ length: MAX_SSH_FORWARD_RULES + 1 }, (_, index) => ({ ...LOCAL, id: String(index), bindPort: 10000 + index }))), false);
});

/** 多级跳板按本机可达主机到最内层主机的顺序返回；直连无跳板。 */
test("jump chain resolves outside-in without mutating saved connections", () => {
  const gateway = { ...CONNECTION, id: "gateway" };
  const inner = { ...CONNECTION, id: "inner", jumpConnectionId: gateway.id };
  const target = { ...CONNECTION, jumpConnectionId: inner.id };
  assert.deepEqual(resolveSshJumpChain(target, [target, inner, gateway]), [gateway, inner]);
  assert.deepEqual(resolveSshJumpChain(CONNECTION, []), []);
});

/** 自引用、间接循环、丢失引用、串口跳板和超长链均不得进入网络层。 */
test("jump chain rejects cycles missing references serial hops and excessive depth", () => {
  assert.throws(() => resolveSshJumpChain({ ...CONNECTION, jumpConnectionId: "target" }, [CONNECTION]));
  assert.throws(() => resolveSshJumpChain({ ...CONNECTION, jumpConnectionId: "missing" }, []));
  const gateway = { ...CONNECTION, id: "gateway", jumpConnectionId: "target" };
  assert.throws(() => resolveSshJumpChain({ ...CONNECTION, jumpConnectionId: gateway.id }, [gateway, CONNECTION]));
  assert.throws(() => resolveSshJumpChain({ ...CONNECTION, jumpConnectionId: gateway.id }, [{ ...gateway, kind: "serial" }]));
  const hops = Array.from({ length: MAX_SSH_JUMP_HOSTS + 1 }, (_, index) => ({ ...CONNECTION, id: `hop-${index}`, jumpConnectionId: index ? `hop-${index - 1}` : "" }));
  assert.equal(resolveSshJumpChain({ ...CONNECTION, jumpConnectionId: `hop-${MAX_SSH_JUMP_HOSTS - 1}` }, hops).length, MAX_SSH_JUMP_HOSTS);
  assert.throws(() => resolveSshJumpChain({ ...CONNECTION, jumpConnectionId: `hop-${MAX_SSH_JUMP_HOSTS}` }, hops));
});

/** 非法配置不得通过白名单复制被静默删除或覆盖现有连接集合。 */
test("serialization rejects invalid advanced rules without changing the input", () => {
  const connection = { id: "invalid", name: "Test", group: "SSH", kind: "ssh", host: "example.invalid", port: 22, username: "test", authType: "agent", keyPath: "", x11: false, forwards: [{ id: "invalid", kind: "local", bindAddress: "127.0.0.1", bindPort: 0, targetHost: "localhost", targetPort: 80 }] };
  const before = structuredClone(connection);
  assert.throws(() => serializeTerminalConnections([connection]), /Invalid terminal connection/);
  assert.deepEqual(connection, before);
});
