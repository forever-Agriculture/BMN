// MODULE: agents-team-tree.d.mts - types for the manifest of what an ask's container binds from its run (Epic 72 review R6)
export declare const TREE_ROOTS: readonly string[]
export declare const TREE_FILE: string
export declare class TreeUnreadable extends Error {}
export interface TreeEntry { path: string; type: 'dir' | 'file' | 'link' | 'absent'; mode?: number; size?: number; sha256?: string; target?: string }
export declare function runTree(folder: string, options?: { harness?: string | null }): { entries: TreeEntry[]; sha256: string }
export declare function treeDigests(folder: string, harness: string): { tree: string; tree_kept?: string }
export declare function treeChange(folder: string, receipt: { harness?: string; snapshots?: { tree?: string; tree_kept?: string } }, phase?: 'check' | 'started'): string | null
