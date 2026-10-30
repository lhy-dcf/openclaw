import { takeBootComposer } from "../../app/boot-composer.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { getChatComposerState, queueComposerSubmit } from "./components/chat-composer-state.ts";

/**
 * The linked session's pane continues what was typed while the page loaded,
 * after its first frame commits the real composer. A saved draft the boot frame
 * could not show stays first, and only text the operator saw when pressing
 * Enter may send by itself, through the composer's normal admission.
 */
export function adoptBootComposer(
  pane: Pick<ChatPaneRuntime, "ownsRouteComposer" | "state" | "presentationId">,
): void {
  const state = pane.state;
  const boot = pane.ownsRouteComposer && state ? takeBootComposer() : null;
  if (!state || !boot) {
    return;
  }
  const composer = getChatComposerState(pane.presentationId);
  const saved = state.chatMessage.trim() ? state.chatMessage : "";
  if (boot.text) {
    const draft = saved ? `${saved}\n${boot.text}` : boot.text;
    state.handleChatDraftChange(draft, saved ? (state.chatMentions ?? []) : []);
    if (boot.submit && !saved) {
      queueComposerSubmit(composer, draft);
    }
  }
  if (!boot.focused) {
    return;
  }
  if (composer.composerTextarea?.isConnected) {
    composer.composerTextarea.focus({ preventScroll: true });
  } else {
    // A composer that attaches later takes focus through its own ref.
    composer.restoreComposerFocus = true;
  }
}
