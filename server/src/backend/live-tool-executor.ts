/**
 * The tool executor of one web session, for the live model of the session.
 *
 * A host tool executor is made for one model: the model id sets the media
 * (vision) context of the tools (`host.toolExecutorFor`). A session can
 * change its model at any time (`RuntimeBackend.setTarget`). An executor
 * that was made one time, at the open of the session, would keep the media
 * context of the first model.
 *
 * This executor keeps one host executor for each model that the session
 * used, and runs each tool call on the executor of the model that is live
 * at that time. The backend sets {@link LiveToolExecutor.model} from the
 * target-change event of the session's own core. It reads no process-wide
 * state, so one session never changes the tools of an other session.
 *
 * @module backend/live-tool-executor
 */

import type { BootedHost } from "@minimal-agent/core/host-kit/host-boot"
import type { ToolExecutor } from "@minimal-agent/core/sdk/ports"

/** A {@link ToolExecutor} that follows the live model of one session. */
export class LiveToolExecutor implements ToolExecutor {
  /** The live model of the session. The backend sets it after each target change. */
  model: string
  private readonly byModel = new Map<string, ToolExecutor>()

  /** Create the executor, with the host executor of the first model. */
  constructor(
    private readonly host: Pick<BootedHost, "toolExecutorFor">,
    model: string,
  ) {
    this.model = model
    this.current()
  }

  /** True when the executor of the live model writes raw-output blobs. */
  get blobStoreEnabled(): boolean {
    return this.current().blobStoreEnabled === true
  }

  /** Run one tool call on the executor of the live model. */
  execute(...args: Parameters<ToolExecutor["execute"]>): ReturnType<ToolExecutor["execute"]> {
    return this.current().execute(...args)
  }

  private current(): ToolExecutor {
    let executor = this.byModel.get(this.model)
    if (executor === undefined) {
      executor = this.host.toolExecutorFor(this.model)
      this.byModel.set(this.model, executor)
    }
    return executor
  }
}
