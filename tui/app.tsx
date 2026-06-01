import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentSession } from "../src/agent-session.js";
import { trajectoryLabel } from "../src/agent-session.js";
import { MAX_TURNS_REACHED } from "../src/defaults.js";
import { AssistantBubble, FileLink, UserBubble } from "./components.js";
import { chatReducer, visibleHistory } from "./chat-state.js";
import { applyEvent } from "./display.js";
import { historyFromContext } from "./history.js";
import type { LiveTurn } from "./types.js";

interface Props {
  session: AgentSession;
  maxTurns: number;
}

export default function App({ session, maxTurns }: Props) {
  const { exit } = useApp();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const [{ history, live }, dispatch] = useReducer(chatReducer, undefined, () => ({
    history: historyFromContext(session.forge.context.messages),
    live: null as LiveTurn | null,
  }));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [trajLabel, setTrajLabel] = useState(() => trajectoryLabel(session.trajPath));
  const [showAll, setShowAll] = useState(false);
  const busyRef = useRef(false);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const lastInputRef = useRef("");

  const persist = useCallback(() => {
    try {
      sessionRef.current.save();
    } catch (e) {
      setStatus(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

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
        const newPath = sessionRef.current.clear();
        setTrajLabel(trajectoryLabel(newPath));
        dispatch({ type: "reset" });
        setShowAll(false);
        setStatus(`cleared · ${trajectoryLabel(newPath)}`);
        return;
      }

      if (text === "/history") {
        setShowAll((v) => !v);
        setStatus("");
        return;
      }

      const { forge } = sessionRef.current;
      const snapshot = forge.context.snapshot();
      const ctrl = new AbortController();
      abortCtrlRef.current = ctrl;
      busyRef.current = true;
      setBusy(true);
      setStatus("");
      lastInputRef.current = text;
      dispatch({ type: "add_user", content: text });
      setInput("");

      let turn: LiveTurn = { content: "", tools: [] };
      dispatch({ type: "live_update", turn });

      try {
        let completed = false;
        for await (const ev of forge.runStream(text, maxTurns, undefined, ctrl.signal)) {
          if (ctrl.signal.aborted) break;
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

        if (ctrl.signal.aborted) {
          forge.context.restore(snapshot);
          dispatch({ type: "undo_last" });
          setInput(lastInputRef.current);
          setStatus("Aborted — input restored");
        } else if (completed) {
          const hitLimit = turn.content === MAX_TURNS_REACHED;
          dispatch({
            type: "complete_turn",
            message: { role: "assistant", content: turn.content, tools: turn.tools },
          });
          if (hitLimit) {
            setStatus("Max turns reached — send a message to continue");
          }
        } else {
          dispatch({ type: "live_clear" });
        }
      } catch (e) {
        if (ctrl.signal.aborted) {
          forge.context.restore(snapshot);
          dispatch({ type: "undo_last" });
          setInput(lastInputRef.current);
          setStatus("Aborted — input restored");
        } else {
          dispatch({ type: "live_clear" });
          setStatus(e instanceof Error ? e.message : String(e));
        }
      } finally {
        abortCtrlRef.current = null;
        busyRef.current = false;
        setBusy(false);
        persist();
      }
    },
    [quit, maxTurns, persist],
  );

  const undo = useCallback(() => {
    const { forge } = sessionRef.current;
    const msgs = forge.context.messages;
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== "user") i--;
    if (i < 0) return;
    const undoneText = msgs[i].content ?? "";
    forge.context.restore(msgs.slice(0, i));
    dispatch({ type: "undo_last" });
    setInput(undoneText);
    setStatus("Undone — edit and resend");
    persist();
  }, [persist]);

  const DOUBLE_ESC_MS = 500;
  const lastEscRef = useRef(0);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") quit();
    if (!key.escape) return;

    const now = Date.now();
    const gap = now - lastEscRef.current;
    lastEscRef.current = now;

    if (busyRef.current) {
      if (gap < DOUBLE_ESC_MS) {
        abortCtrlRef.current?.abort();
        setStatus("");
      } else {
        setStatus("Press Esc again to abort");
      }
    } else {
      if (gap < DOUBLE_ESC_MS) {
        undo();
      } else {
        setStatus("Press Esc again to undo");
      }
    }
  });

  const { hidden, items: messages } = visibleHistory(history, showAll);

  return (
    <Box flexDirection="column" height="100%">
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginBottom={1}
      >
        <Box justifyContent="space-between">
          <Text bold>ds-forge</Text>
          <FileLink path={session.trajPath} label={trajLabel} />
        </Box>
        <FileLink path={session.cwd} />
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {history.length === 0 && !live && (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>Agent TUI — type a message to begin</Text>
            <Text dimColor>Esc undo · /clear · /history · /quit</Text>
          </Box>
        )}

        {hidden > 0 && (
          <Box marginBottom={1}>
            <Text dimColor>… {hidden} older messages hidden · /history to expand</Text>
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
          <Text dimColor>Agent is thinking… <Text color="gray">(Esc to undo)</Text></Text>
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
