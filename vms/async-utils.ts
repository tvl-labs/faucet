export async function asyncCallWithTimeout<T>(
  asyncPromise: Promise<T>,
  timeLimit: number,
  timeoutMessage: string
): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(timeoutMessage)),
          timeLimit
        );
    });

    try {
        return await Promise.race([asyncPromise, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}