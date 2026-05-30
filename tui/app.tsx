import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { Forge } from "../src/forge.js";
import { agentSystem } from "./system.js";
import { AssistantBubble, UserBubble } from "./components.js";
import { chatReducer, visibleHistory } from "./chat-state.js";
import { applyEvent, truncateLine } from "./display.js";
import {
  createTrajectoryPath,
  historyFromContext,
  saveTrajectory,
  trajectoryLabel,
} from "./trajectory.js";
import type { LiveTurn } from "./types.js";

interface Props {
  forge: Forge;
  cwd: string;
  maxTurns: number;
  trajPath: string;
}

export default function App({ forge, cwd, maxTurns, trajPath: initialTrajPath }: Props) {
  const { exit } = useApp();
  const trajPathRef = useRef(initialTrajPath);
  const [{ history, live }, dispatch] = useReducer(chatReducer, undefined, () => ({
    history: historyFromContext(forge.context.messages),
    live: null as LiveTurn | null,
  }));
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
        dispatch({ type: "reset" });
        setStatus(`cleared · ${trajectoryLabel(trajPathRef.current)}`);
        return;
      }

      busyRef.current = true;
      setBusy(true);
      setStatus("");
      dispatch({ type: "add_user", content: text });
      setInput("");

      let turn: LiveTurn = { content: "", tools: [] };
      dispatch({ type: "live_update", turn });

      try {
        let completed = false;
        for await (const ev of forge.runStream(text, maxTurns)) {
          if (ev.type === "error") {
            setStatus(ev.message);
            break;
          }
          if (ev.type === "turn_done") {
            turn = { ...turn, content: ev.content || turn.content };
            completed = true;
            break;
          }
          turn = applyEvent(turn, ev);
          dispatch({ type: "live_update", turn: { ...turn } });
        }

        if (completed) {
          dispatch({
            type: "complete_turn",
            message: { role: "assistant", content: turn.content, tools: turn.tools },
          });
        } else {
          dispatch({ type: "live_clear" });
        }
      } catch (e) {
        dispatch({ type: "live_clear" });
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
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

  const { hidden, items: messages } = visibleHistory(history);

  return (
    <Box flexDirection="column" height="100%">
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginBottom={1}
        justifyContent="space-between"
      >
        <Text bold>ds-forge</Text>
        <Text dimColor>
          {trajectoryLabel(trajPathRef.current)} · {truncateLine(cwd, 32)}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {history.length === 0 && !live && (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>Agent TUI — type a message to begin</Text>
            <Text dimColor>/clear · /quit · Ctrl+C · --cwd --resume</Text>
          </Box>
        )}

        {hidden > 0 && (
          <Box marginBottom={1}>
            <Text dimColor>… {hidden} older messages hidden</Text>
          </Box>
        )}

        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <UserBubble key={`u-${i}`} content={msg.content} />
          ) : (
            <AssistantBubble
              key={`a-${i}`}
              content={msg.content}
              tools={msg.tools}
            />
          ),
        )}

        {live && (
          <AssistantBubble content={live.content} tools={live.tools} streaming />
        )}
      </Box>

      {status && (
        <Box marginBottom={1}>
          <Text color="red">{status}</Text>
        </Box>
      )}

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
