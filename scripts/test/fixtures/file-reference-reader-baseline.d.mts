import type { FileReferenceReadResult } from '../../../shared/protocol/src/index'
import type { FileReferenceReadRequest, FileReferenceReaderOptions } from '../../../apps/desktop/src/utility/file-reference-reader'
export function readFileReference(request: FileReferenceReadRequest, options?: FileReferenceReaderOptions): Promise<FileReferenceReadResult>
