import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Forge } from "../src/forge.js";
import type { StreamEvent } from "../src/types.js";
import { agentSystem } from "./system.js";
import {
  createTrajectoryPath,
  historyFromContext,
  saveTrajectory,
  trajectoryLabel,
} from "./trajectory.js";
import type { AssistantMessage, HistoryMessage, LiveTurn } from "./types.js";

interface Props {
  forge: Forge;
  cwd: string;
  maxTurns: number;
  trajPath: string;
}

function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

function UserBubble({ content }: { content: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>
        ❯ You
      </Text>
      <Text wrap="wrap">{content}</Text>
    </Box>
  );
}

function formatToolLabel(name: string, args: string): { title: string; detail: string } {
  if (name === "bash") {
    try {
      const parsed = JSON.parse(args) as { command?: string };
      return { title: "bash", detail: parsed.command ?? args };
    } catch {
      return { title: "bash", detail: args };
    }
  }
  return { title: name, detail: truncate(args, 80) };
}

function ToolBlockView({
  name,
  args,
  result,
  running,
}: {
  name: string;
  args: string;
  result?: string;
  running: boolean;
}) {
  const { title, detail } = formatToolLabel(name, args);
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color="yellow" dimColor={running}>
        {running ? "◌ " : "⎿ "}
        <Text bold>{title}</Text>
      </Text>
      <Box marginLeft={2}>
        <Text color="gray" wrap="wrap">
          $ {detail}
        </Text>
      </Box>
      {result !== undefined && (
        <Box marginLeft={2} flexDirection="column">
          <Text dimColor wrap="wrap">
            {result}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function AssistantBubble({
  content,
  tools,
  streaming,
}: {
  content: string;
  tools: AssistantMessage["tools"];
  streaming?: boolean;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="green" bold>
        ◆ Agent
      </Text>
      {(content || streaming) && (
        <Text wrap="wrap">
          {content}
          {streaming && <Text color="green">▍</Text>}
        </Text>
      )}
      {tools.map((t) => (
        <ToolBlockView
          key={t.id}
          name={t.name}
          args={t.args}
          result={t.result}
          running={t.running}
        />
      ))}
    </Box>
  );
}

function applyEvent(turn: LiveTurn, ev: StreamEvent): LiveTurn {
  switch (ev.type) {
    case "text_delta":
      return { ...turn, content: turn.content + ev.delta };
    case "tool_call_start":
      return {
        ...turn,
        tools: [
          ...turn.tools,
          { id: ev.id, name: ev.name, args: ev.arguments, running: true },
        ],
      };
    case "tool_result":
      return {
        ...turn,
        tools: turn.tools.map((t) =>
          t.id === ev.id ? { ...t, result: ev.result, running: false } : t,
        ),
      };
    default:
      return turn;
  }
}

export default function App({ forge, cwd, maxTurns, trajPath: initialTrajPath }: Props) {
  const { exit } = useApp();
  const trajPathRef = useRef(initialTrajPath);
  const [history, setHistory] = useState<HistoryMessage[]>(() =>
    historyFromContext(forge.context.messages),
  );
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const busyRef = useRef(false);

  const persist = useCallback(() => {
    try {
      saveTrajectory(forge, trajPathRef.current);
    } catch (e) {
      setStatus(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [forge]);

  const quit = useCallback(() => {
    persist();
    exit();
  }, [persist, exit]);

  useEffect(() => () => persist(), [persist]);

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;

      if (text === "/quit" || text === "/exit") {
        quit();
        return;
      }

      if (text === "/clear") {
        forge.context.clear();
        forge.context.addSystem(agentSystem(cwd));
        trajPathRef.current = createTrajectoryPath();
        setHistory([]);
        setLive(null);
        setStatus(`cleared · ${trajectoryLabel(trajPathRef.current)}`);
        return;
      }

      busyRef.current = true;
      setBusy(true);
      setStatus("");
      setHistory((h) => [...h, { role: "user", content: text }]);
      setInput("");

      let turn: LiveTurn = { content: "", tools: [] };
      setLive(turn);

      try {
        for await (const ev of forge.runStream(text, maxTurns)) {
          if (ev.type === "error") {
            setStatus(ev.message);
            break;
          }
          if (ev.type === "turn_done") {
            turn = { ...turn, content: ev.content || turn.content };
            break;
          }
          turn = applyEvent(turn, ev);
          setLive({ ...turn });
        }

        setHistory((h) => [
          ...h,
          { role: "assistant", content: turn.content, tools: turn.tools },
        ]);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setLive(null);
        busyRef.current = false;
        setBusy(false);
        persist();
      }
    },
    [forge, quit, maxTurns, cwd, persist],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") quit();
  });

  return (
    <Box flexDirection="column" height="100%">
      {/* header */}
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginBottom={1}
        justifyContent="space-between"
      >
        <Text bold>ds-forge</Text>
        <Text dimColor>
          {trajectoryLabel(trajPathRef.current)} · {truncate(cwd, 32)}
        </Text>
      </Box>

      {/* messages */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {history.length === 0 && !live && (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>Agent TUI — type a message to begin</Text>
            <Text dimColor>/clear · /quit · Ctrl+C · --cwd --resume</Text>
          </Box>
        )}

        <Static items={history}>
          {(msg, i) =>
            msg.role === "user" ? (
              <UserBubble key={`u-${i}`} content={msg.content} />
            ) : (
              <AssistantBubble
                key={`a-${i}`}
                content={msg.content}
                tools={msg.tools}
              />
            )
          }
        </Static>

        {live && (
          <AssistantBubble content={live.content} tools={live.tools} streaming />
        )}
      </Box>

      {/* status */}
      {status && (
        <Box marginBottom={1}>
          <Text color="red">{status}</Text>
        </Box>
      )}

      {/* input */}
      <Box
        borderStyle="round"
        borderColor={busy ? "gray" : "cyan"}
        paddingX={1}
        flexDirection="column"
      >
        {busy ? (
          <Text dimColor>Agent is thinking…</Text>
        ) : (
          <Box>
            <Text color="cyan" bold>
              ❯{" "}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              placeholder="Message the agent…"
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
