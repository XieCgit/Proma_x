/**
 * 运行槽已占用、主循环的 finally 尚未建立时，启动准备失败必须释放槽位。
 * 成功时保留槽位供后续运行使用；释放函数由调用方按运行代际校验。
 */
export async function releaseActiveRunOnPreflightFailure<T>(
  prepare: () => Promise<T> | T,
  release: () => void,
): Promise<T> {
  try {
    return await prepare()
  } catch (error) {
    release()
    throw error
  }
}
