import type { AssistantMessage, HistoryMessage, LiveTurn } from "./types.js";

export type ChatState = {
  history: HistoryMessage[];
  live: LiveTurn | null;
};

export type ChatAction =
  | { type: "reset" }
  | { type: "add_user"; content: string }
  | { type: "live_update"; turn: LiveTurn }
  | { type: "complete_turn"; message: AssistantMessage }
  | { type: "live_clear" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return { history: [], live: null };
    case "add_user":
      return {
        ...state,
        history: [...state.history, { role: "user", content: action.content }],
      };
    case "live_update":
      return { ...state, live: action.turn };
    case "complete_turn":
      return {
        history: [...state.history, action.message],
        live: null,
      };
    case "live_clear":
      return { ...state, live: null };
    default:
      return state;
  }
}

/** Keep the viewport bounded — older turns scroll off. */
export const MAX_VISIBLE_MESSAGES = 12;

export function visibleHistory(history: HistoryMessage[]): {
  hidden: number;
  items: HistoryMessage[];
} {
  if (history.length <= MAX_VISIBLE_MESSAGES) {
    return { hidden: 0, items: history };
  }
  const hidden = history.length - MAX_VISIBLE_MESSAGES;
  return { hidden, items: history.slice(-MAX_VISIBLE_MESSAGES) };
}
