/**
 * The chat (spec 4.4, S55): `useChat` over `POST /api/sessions/:id/messages`.
 *
 * Built on the Chat pattern of the shadcn/ui registry
 * (`/docs/ai-elements/radix/chat`): Message Scroller, Message, Bubble, and a
 * Prompt Input. The server owns the conversation, so the request body is just
 * the new text. An ask (core's preflight `ask_user`, spec v1 S17 — a plain
 * multiple-choice question, not a tool approval: core has no tool-approval
 * concept) is answered with `POST /answers`; Stop aborts the run on the
 * server with `POST /abort`.
 *
 * A run this tab did not stream (another tab's, or one that was running
 * when this page loaded) shows in the event log only. When the log has more
 * finished runs than the history had plus the runs this tab started, the
 * chat reloads its history.
 *
 * @module chat/chat-view
 */

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { ArrowUpIcon, MessageCircleDashedIcon, SquareIcon } from "lucide-react"
import * as React from "react"
import { abortTurn, answerAsk, authHeaders, getSession, reportUnauthorized } from "@/api/client.ts"
import type { ChatMessage, StatusData } from "@/api/types.ts"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Message, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"

import { type DecodedMessage, decodeHistory } from "./history.ts"
import { AssistantParts } from "./message-parts.tsx"
import { statusText } from "./status-text.ts"

/** The scripted transport's scenarios, by the word that picks each (server `transport/scripted-transport.ts`). */
const SCRIPT_HINTS = [
  ["think", "shows reasoning"],
  ["retry", "retries, with status"],
  ["quota", "waits for a quota reset"],
  ["fail", "pauses on a permanent error"],
  ["long", "a long reply, to try Stop"],
] as const

/** Props of {@link ChatView}. */
export interface ChatViewProps {
  sessionId: string
  initial: DecodedMessage[]
  /** A run is active on the server (from the event log). */
  runActive: boolean
  /** `run_finished` entries in the event log so far. */
  finishedRuns: number
  /** Called with the messages whenever they change, for the Context element. */
  onMessages?: (messages: ChatMessage[]) => void
}

function textOf(message: ChatMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
}

/** The chat of one session. Mount it with `key={sessionId}`. */
export function ChatView(props: ChatViewProps) {
  const { sessionId, initial, runActive, finishedRuns, onMessages } = props
  const [status, setStatus] = React.useState<StatusData | null>(null)
  const [draft, setDraft] = React.useState("")
  const [notes, setNotes] = React.useState(() => {
    const map = new Map<string, string[]>()
    for (const item of initial) if (item.errors.length > 0) map.set(item.message.id, item.errors)
    return map
  })
  /** Finished runs the shown messages already hold. */
  const shownRuns = React.useRef(
    initial.filter((item) => item.message.role === "assistant" && !item.running).length,
  )
  /** Runs this tab started since the messages were last loaded. */
  const localRuns = React.useRef(0)
  const busyRef = React.useRef(false)
  const formRef = React.useRef<HTMLFormElement>(null)

  const transport = React.useMemo(
    () =>
      new DefaultChatTransport<ChatMessage>({
        api: `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        headers: () => authHeaders(),
        prepareSendMessagesRequest: ({ messages }) => {
          const last = messages.at(-1)
          return { body: { text: last === undefined ? "" : textOf(last) } }
        },
      }),
    [sessionId],
  )

  const chat = useChat<ChatMessage>({
    id: sessionId,
    messages: initial.map((item) => item.message),
    transport,
    onData: (part) => {
      if (part.type === "data-status") setStatus(part.data)
    },
    onFinish: () => {
      setStatus(null)
    },
    onError: (error) => {
      setStatus(null)
      if (/unauthorized/iu.test(error.message)) reportUnauthorized()
    },
  })
  const { messages, sendMessage, setMessages, stop, error } = chat
  const busy = chat.status === "submitted" || chat.status === "streaming"
  const working = busy || runActive

  React.useEffect(() => {
    busyRef.current = busy
  }, [busy])

  React.useEffect(() => onMessages?.(messages), [messages, onMessages])

  // A run that this tab did not stream ended: show it from the history.
  React.useEffect(() => {
    let cancelled = false
    const stale = finishedRuns > shownRuns.current + localRuns.current
    if (stale) void reload()
    async function reload() {
      const detail = await getSession(sessionId)
      if (detail === null || cancelled) return
      const decoded = await decodeHistory(detail.history)
      if (cancelled || busyRef.current) return
      shownRuns.current = finishedRuns
      localRuns.current = 0
      setNotes(
        new Map(
          decoded.flatMap((item) =>
            item.errors.length > 0 ? [[item.message.id, item.errors]] : [],
          ),
        ),
      )
      setMessages(decoded.map((item) => item.message))
    }
    return () => {
      cancelled = true
    }
  }, [finishedRuns, sessionId, setMessages])

  const canSend = draft.trim().length > 0 && !working

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    localRuns.current++
    void sendMessage({ text: draft.trim() })
    setDraft("")
  }

  async function onStop() {
    await stop()
    setStatus(null)
    await abortTurn(sessionId)
  }

  const handlers = {
    onAnswer: (askId: string, answer: string | null) => {
      void answerAsk(sessionId, askId, answer)
    },
  }

  return (
    <MessageScrollerProvider autoScroll>
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="min-h-0 flex-1">
          {messages.length === 0 ? (
            <EmptyChat />
          ) : (
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent aria-busy={working} className="gap-6 px-6 py-4">
                  {messages.map((message) => {
                    if (message.role === "user") {
                      return (
                        <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor>
                          <Message align="end">
                            <MessageContent>
                              <Bubble align="end" variant="muted">
                                <BubbleContent data-testid="user-text">
                                  {textOf(message)}
                                </BubbleContent>
                              </Bubble>
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      )
                    }
                    const last = message === messages.at(-1)
                    return (
                      <MessageScrollerItem key={message.id} messageId={message.id}>
                        <Message data-testid="assistant-message">
                          <MessageContent className="gap-3">
                            <AssistantParts
                              message={message}
                              streaming={working && last}
                              handlers={handlers}
                            />
                            {notes.get(message.id)?.map((note) => (
                              <p key={note} className="text-sm text-destructive">
                                {note}
                              </p>
                            ))}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )
                  })}
                  {chat.status === "submitted" && (
                    <p className="shimmer text-sm text-muted-foreground">
                      Waiting for the agent&hellip;
                    </p>
                  )}
                  {status !== null && busy && (
                    <p className="shimmer text-sm text-muted-foreground" data-testid="status-line">
                      {statusText(status)}
                    </p>
                  )}
                  {runActive && !busy && (
                    <p className="shimmer text-sm text-muted-foreground">
                      A turn is running on the server. This chat updates when it ends.
                    </p>
                  )}
                  {error !== undefined && (
                    <p className="text-sm text-destructive" data-testid="chat-error">
                      {error.message}
                    </p>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          )}
        </div>
        <form ref={formRef} onSubmit={onSubmit} className="px-6 pb-6">
          <InputGroup>
            <InputGroupTextarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Send a message"
              aria-label="Message"
              className="min-h-14 p-3"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  formRef.current?.requestSubmit()
                }
              }}
            />
            <InputGroupAddon align="block-end">
              {working ? (
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="default"
                  className="ml-auto rounded-full"
                  aria-label="Stop"
                  onClick={() => void onStop()}
                >
                  <SquareIcon />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  size="icon-sm"
                  variant="default"
                  className="ml-auto rounded-full"
                  disabled={!canSend}
                  aria-label="Send"
                >
                  <ArrowUpIcon />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </MessageScrollerProvider>
  )
}

function EmptyChat() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageCircleDashedIcon />
        </EmptyMedia>
        <EmptyTitle>Start the conversation</EmptyTitle>
        <EmptyDescription>
          Every reply is scripted (see the banner above). A word in your message picks the script:
        </EmptyDescription>
      </EmptyHeader>
      <ul className="grid gap-1 text-left text-sm text-muted-foreground">
        {SCRIPT_HINTS.map(([word, what]) => (
          <li key={word}>
            <span className="font-mono text-foreground">{word}</span>: {what}
          </li>
        ))}
      </ul>
    </Empty>
  )
}
