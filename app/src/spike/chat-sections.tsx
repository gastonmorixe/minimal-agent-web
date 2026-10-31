/**
 * Build spike (S52): the AI Elements patterns for the chat itself.
 *
 * Each section follows the "Usage" code of its pattern page at
 * ui.shadcn.com/docs/ai-elements/radix/<name> (Code Block and Shimmer follow
 * their component and utility pages), with static sample data. The components
 * come from the shadcn/ui registry. The real chat UI is S55.
 */

import { ArrowUpIcon, CopyIcon, FileTextIcon, PlusIcon, TerminalIcon, XIcon } from "lucide-react"
import * as React from "react"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"

/** Conversation (the Chat pattern): message turns inside a Message Scroller. */
export function ConversationSection() {
  return (
    <div className="h-56 rounded-xl border">
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="p-4">
              <MessageScrollerItem messageId="user-1" scrollAnchor>
                <Message align="end">
                  <MessageContent>
                    <Bubble align="end" variant="muted">
                      <BubbleContent>Which events does core emit today?</BubbleContent>
                    </Bubble>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
              <MessageScrollerItem messageId="assistant-1">
                <Message>
                  <MessageContent>
                    <p>
                      Nine kinds: turn and item events, text and thinking deltas, tool results,
                      notices, and errors.
                    </p>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}

/** Message: one turn. The person's bubble, and the agent's reply with actions. */
export function MessageSection() {
  return (
    <div className="flex flex-col gap-4">
      <Message align="end">
        <MessageContent>
          <Bubble align="end" variant="muted">
            <BubbleContent>How do I start the server?</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      <Message>
        <MessageContent className="gap-2">
          <p>Run bun run start from the repo root.</p>
          <MessageFooter>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Copy">
                  <CopyIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy</TooltipContent>
            </Tooltip>
          </MessageFooter>
        </MessageContent>
      </Message>
    </div>
  )
}

/** Prompt Input: a message field with attachments and a send button. */
export function PromptInputSection() {
  const [text, setText] = React.useState("")
  const [files, setFiles] = React.useState(["notes.md"])

  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <InputGroup>
        {files.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap">
            {files.map((name) => (
              <Attachment key={name} size="sm">
                <AttachmentMedia>
                  <FileTextIcon />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{name}</AttachmentTitle>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={`Remove ${name}`}
                    onClick={() => setFiles((current) => current.filter((item) => item !== name))}
                  >
                    <XIcon />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Ask the agent to change your code..."
          className="p-3"
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton
            size="icon-sm"
            variant="outline"
            className="rounded-full"
            aria-label="Attach files"
          >
            <PlusIcon />
          </InputGroupButton>
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            className="ml-auto rounded-full"
            disabled={text.trim().length === 0}
            aria-label="Send"
          >
            <ArrowUpIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

/** Context: how much of the context window the conversation has used. */
export function ContextSection() {
  const used = 48_200
  const limit = 200_000
  const percent = Math.round((used / limit) * 100)

  return (
    <HoverCard openDelay={10} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button variant="outline" size="sm" className="self-start">
          {percent}% context
        </Button>
      </HoverCardTrigger>
      <HoverCardContent className="flex w-64 flex-col gap-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Context</span>
          <span className="text-muted-foreground">
            {used.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}
          </span>
        </div>
        <Progress value={percent} aria-label="Context used" />
      </HoverCardContent>
    </HoverCard>
  )
}

/** Confirmation: a prompt to approve or deny a tool before it runs. */
export function ConfirmationSection() {
  const [answer, setAnswer] = React.useState<"approved" | "denied" | null>(null)

  return (
    <Item variant="outline" size="sm">
      <ItemMedia variant="icon">
        <TerminalIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Run rm -rf dist?</ItemTitle>
        <ItemDescription>
          {answer === null ? "The command runs in this project." : `You ${answer} it.`}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="outline" onClick={() => setAnswer("denied")}>
          Deny
        </Button>
        <Button size="sm" onClick={() => setAnswer("approved")}>
          Approve
        </Button>
      </ItemActions>
    </Item>
  )
}

const SAMPLE_CODE = `const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("ok"),
})`

/** Code Block: code with a header, a copy button, and syntax highlighting. */
export function CodeBlockSection() {
  const lines = useHighlightedCode(SAMPLE_CODE, "ts")

  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileTextIcon />
          server/src/main.ts
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={SAMPLE_CODE} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          // A line has no identity beyond its position.
          // oxlint-disable-next-line react/no-array-index-key
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** Shimmer: the `shimmer` utility class from `shadcn/tailwind.css`. */
export function ShimmerSection() {
  return <p className="shimmer text-sm text-muted-foreground">Generating response&hellip;</p>
}
