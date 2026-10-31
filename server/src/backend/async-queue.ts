/**
 * A push-based async iterable: producers `push` and `end`, one consumer
 * reads with `for await`. Turns a callback subscription into the
 * `AsyncIterable` a {@link TurnHandle} returns.
 *
 * @module backend/async-queue
 */

/** One-consumer async queue. `onClose` runs once, when the queue ends or the consumer stops. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private waiter: ((result: IteratorResult<T>) => void) | null = null
  private ended = false
  private closed = false

  /** Create the queue. */
  constructor(private readonly onClose: () => void = () => {}) {}

  /** Add a value. Ignored after `end`. */
  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiter
    if (waiter !== null) {
      this.waiter = null
      waiter({ value, done: false })
      return
    }
    this.values.push(value)
  }

  /** End the queue. Values already pushed are still read. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.close()
    const waiter = this.waiter
    if (waiter !== null && this.values.length === 0) {
      this.waiter = null
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
      return: () => {
        this.values.length = 0
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }
}
