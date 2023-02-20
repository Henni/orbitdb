import { EventEmitter } from 'events'
import PQueue from 'p-queue'

const defaultPointerCount = 16

const Database = async ({ OpLog, ipfs, identity, databaseId, accessController, storage, headsStorage, pointerCount }) => {
  const { Log, Entry, IPFSBlockStorage, LevelStorage } = OpLog

  const entryStorage = storage || await IPFSBlockStorage({ ipfs, pin: true })
  headsStorage = headsStorage || await LevelStorage({ path: `./${identity.id}/${databaseId}/log/_heads/` })
  // const indexStorage = await LevelStorage({ path: `./${identity.id}/${databaseId}/log/_index/` })

  // const log = await Log(identity, { logId: databaseId, access: accessController, entryStorage, headsStorage, indexStorage })
  const log = await Log(identity, { logId: databaseId, access: accessController, entryStorage, headsStorage })

  const events = new EventEmitter()

  const queue = new PQueue({ concurrency: 1 })

  pointerCount = pointerCount || defaultPointerCount

  const addOperation = async (op) => {
    const task = async () => {
      const entry = await log.append(op, { pointerCount })
      await ipfs.pubsub.publish(databaseId, entry.bytes)
      events.emit('update', entry)
      return entry.hash
    }
    return queue.add(task)
  }

  const handleMessage = async (message) => {
    const { id: peerId } = await ipfs.id()
    const messageIsNotFromMe = (message) => String(peerId) !== String(message.from)
    const messageHasData = (message) => message.data !== undefined
    try {
      if (messageIsNotFromMe(message) && messageHasData(message)) {
        await sync(message.data)
      }
    } catch (e) {
      console.error(e)
      events.emit('error', e)
    }
  }

  const sync = async (bytes) => {
    const task = async () => {
      const entry = await Entry.decode(bytes)
      if (entry) {
        events.emit('sync', entry)
        const updated = await log.joinEntry(entry)
        if (updated) {
          events.emit('update', entry)
        }
      }
    }
    await queue.add(task)
  }

  const close = async () => {
    await ipfs.pubsub.unsubscribe(log.id, handleMessage)
    await queue.onIdle()
    await log.close()
    events.emit('close')
  }

  // TODO: rename to clear()
  const drop = async () => {
    await queue.onIdle()
    await log.clear()
  }

  const merge = async (other) => {}

  // Automatically subscribe to the pubsub channel for this database
  await ipfs.pubsub.subscribe(log.id, handleMessage)

  return {
    databaseId,
    identity,
    sync,
    merge,
    close,
    drop,
    addOperation,
    log,
    events
  }
}

export default Database
