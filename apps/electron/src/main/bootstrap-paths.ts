/**
 * 必须作为主进程入口的第一个 import：在任何业务模块初始化前设置独立身份。
 * 与上游应用分开 Chromium userData、sessionData 和单实例锁。
 */
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getIndependentUserDataDirName } from '@proma/shared/config'

const directoryName = getIndependentUserDataDirName(!app.isPackaged, process.env.PROMA_DEV_INSTANCE)
const userData = join(app.getPath('appData'), directoryName)
mkdirSync(userData, { recursive: true })
app.setName('Proma Agent Next')
app.setPath('userData', userData)
app.setPath('sessionData', userData)
