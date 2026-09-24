// MODULE: bounded-read.ts - cap renderer reads so a failed local request cannot leave a dialog loading forever
export function boundedRead<T>(read: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The read timed out')), timeoutMs)
    read.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (cause: unknown) => { clearTimeout(timer); reject(cause) }
    )
  })
}
