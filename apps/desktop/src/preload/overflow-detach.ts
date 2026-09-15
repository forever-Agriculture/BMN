export async function recoverAfterTransportFailure(
  recover: () => Promise<unknown>
): Promise<void> {
  try {
    await recover()
  } catch {
    // The renderer already receives the failure notice; fresh-view recovery is best-effort here.
  }
}

export const detachAfterTransportOverflow = recoverAfterTransportFailure
