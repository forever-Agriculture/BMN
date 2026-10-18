// A worker that takes every request and answers none: the client must end it when a stopped search does not come back.
import { parentPort } from 'node:worker_threads'

parentPort?.on('message', () => undefined)
