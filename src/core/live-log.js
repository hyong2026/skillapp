/**
 * live-log.js — prompt 型 Skill 的实时进度日志（live.log）
 *
 * prompt 型 Skill 的 cmd 走 `codex exec`，默认会把整段 agent 会话（每条命令、每段工具输出、
 * 每次思考）打进 stderr：一次运行几百 KB，没法读。SkillApp 给这条命令补上 `--json` 之后，
 * stdout 变成"一行一个事件"的 JSONL，这里把它整理成给人看的 live.log：
 *
 *   [msg]    模型说的进度（最后一条就是这次运行的"答案"）
 *   [cmd]    它跑的命令（原样，行内不截断——排查问题时"..."最碍事）
 *   [error]  运行期报错
 *
 * 只挑这三类：工具输出、思考过程与 token 统计都是噪声，需要时去看 artifacts /
 * stdout.log / stderr.log。解析不了的行原样透传——换成别的 agent CLI 时，live.log
 * 至少还是它的原始输出。
 */

/** 多行内容只在第一行加前缀、续行缩进：读起来是一块，而不是一行一条。 */
const block = (prefix, text) =>
  String(text).split('\n').map((line, i) => (i === 0 ? prefix + line : `  ${line}`)).join('\n') + '\n';

/**
 * 事件流 → live.log 文本。
 *
 * `push` 是增量喂的：chunk 的切分点可能落在行中间，所以留半行到下一次（子进程的输出
 * 没有行边界保证）。`flush` 在进程结束时收尾那半行。
 */
function createCodexEvents() {
  let buffer = '';
  let finalMessage = null;
  let lastError = null;

  const format = (raw) => {
    const text = raw.trim();
    if (!text) return '';
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return `${raw}\n`;
    }
    if (!event || typeof event !== 'object') return `${raw}\n`;

    if (event.type === 'error') {
      lastError = String(event.message || 'Skill reported an error');
      return block('[error] ', lastError);
    }
    if (event.type !== 'item.completed' || !event.item) return '';

    const item = event.item;
    if (item.type === 'agent_message' && item.text) {
      finalMessage = String(item.text);
      return block('[msg] ', item.text);
    }
    if (item.type === 'command_execution' && item.command) return block('[cmd] ', String(item.command));
    return '';
  };

  return {
    /** 喂一段原始输出，返回这段里"值得进日志"的文本（可能为空）。 */
    push(chunk) {
      buffer += String(chunk ?? '');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      return lines.reduce((out, line) => out + format(line), '');
    },
    /** 收尾：最后一行可能没有换行符。 */
    flush() {
      if (!buffer) return '';
      const rest = format(buffer);
      buffer = '';
      return rest;
    },
    /** 最后一条 agent 消息——prompt 型 Skill 的答案（一行 JSON）就在里面。 */
    finalMessage() {
      return finalMessage;
    },
    /** 事件流里报告的最后一个错误，用于进程非零退出时给一行有用的 error。 */
    lastError() {
      return lastError;
    },
  };
}

export { createCodexEvents };
