// MODULE: brain-schema.ts - The brain's independent schema; never migrates session state
import type { DatabaseConnection } from './database-initialization'
import {brainAttachmentReferences} from './brain-attachment-references'

export function initializeBrain(database: DatabaseConnection): void {
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS brain_migration(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS brain_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO brain_meta VALUES ('write_door', 'closed');
      CREATE TABLE IF NOT EXISTS brain_note(
        id TEXT PRIMARY KEY, head_revision INTEGER NOT NULL, status TEXT NOT NULL
          CHECK(status IN ('active','archived','withdrawn')),
        normalized_title TEXT NOT NULL, import_source TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS brain_title ON brain_note(normalized_title);
      CREATE TABLE IF NOT EXISTS brain_version(
        note TEXT NOT NULL REFERENCES brain_note(id), revision INTEGER NOT NULL,
        action TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL,
        session TEXT NOT NULL, scope TEXT NOT NULL, superseded_by TEXT,
        markdown TEXT NOT NULL, checksum TEXT NOT NULL, recorded_at TEXT NOT NULL,
        source_time TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY(note, revision)
      );
      CREATE TRIGGER IF NOT EXISTS brain_history_no_update BEFORE UPDATE ON brain_version
        BEGIN SELECT RAISE(ABORT, 'Brain history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS brain_history_no_delete BEFORE DELETE ON brain_version
        BEGIN SELECT RAISE(ABORT, 'Brain history is append-only'); END;
      CREATE TABLE IF NOT EXISTS brain_link(
        note TEXT NOT NULL REFERENCES brain_note(id), kind TEXT NOT NULL,
        target TEXT NOT NULL, resolved TEXT, PRIMARY KEY(note,kind,target)
      );
      CREATE INDEX IF NOT EXISTS brain_backlink ON brain_link(resolved);
      CREATE TABLE IF NOT EXISTS brain_attachment(
        note TEXT NOT NULL REFERENCES brain_note(id), path TEXT NOT NULL,
        hash TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(note,path)
      );
      CREATE TABLE IF NOT EXISTS brain_session_created(
        session TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK(count BETWEEN 0 AND 3)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS brain_search USING fts5(
        note UNINDEXED, title, markdown, tokenize='trigram'
      );
      INSERT OR IGNORE INTO brain_migration VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `)
    const newer = database.prepare('SELECT version FROM brain_migration WHERE version > 3').get()
    if (newer) throw new Error('Brain schema is newer than this build')
    if (!database.prepare('SELECT version FROM brain_migration WHERE version=2').get()) {
      database.exec(`
        ALTER TABLE brain_attachment RENAME TO brain_attachment_legacy;
        CREATE TABLE brain_attachment(
          note TEXT NOT NULL, revision INTEGER NOT NULL, path TEXT NOT NULL,
          hash TEXT, size INTEGER, state TEXT NOT NULL
            CHECK(state IN ('captured','missing','ambiguous','unknown','legacy')),
          PRIMARY KEY(note,revision,path),
          FOREIGN KEY(note,revision) REFERENCES brain_version(note,revision),
          CHECK(state!='captured' OR (hash IS NOT NULL AND size IS NOT NULL AND size>=0))
        );
        INSERT INTO brain_attachment(note,revision,path,hash,size,state)
          SELECT a.note,n.head_revision,a.path,a.hash,a.size,'legacy'
          FROM brain_attachment_legacy a JOIN brain_note n ON n.id=a.note;
        DROP TABLE brain_attachment_legacy;
        INSERT INTO brain_migration VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      `)
    }
    if(!database.prepare('SELECT version FROM brain_migration WHERE version=3').get()){
      database.exec(`
        ALTER TABLE brain_attachment RENAME TO brain_attachment_prior;
        CREATE TABLE brain_attachment(
          note TEXT NOT NULL, revision INTEGER NOT NULL, reference TEXT NOT NULL, path TEXT NOT NULL,
          hash TEXT, size INTEGER, state TEXT NOT NULL CHECK(state IN ('captured','missing','ambiguous','unknown','legacy')),
          PRIMARY KEY(note,revision,reference), FOREIGN KEY(note,revision) REFERENCES brain_version(note,revision),
          CHECK(state!='captured' OR (hash IS NOT NULL AND size IS NOT NULL AND size>=0))
        );
        INSERT INTO brain_attachment SELECT note,revision,'legacy:'||state||':'||path,path,hash,size,'legacy' FROM brain_attachment_prior;
        DROP TABLE brain_attachment_prior;
        CREATE TABLE brain_attachment_coverage(
          note TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('complete','unproven')),
          PRIMARY KEY(note,revision), FOREIGN KEY(note,revision) REFERENCES brain_version(note,revision)
        );
        INSERT INTO brain_attachment_coverage SELECT note,revision,'unproven' FROM brain_version;
        CREATE TABLE brain_import_current(source TEXT PRIMARY KEY,note TEXT NOT NULL UNIQUE REFERENCES brain_note(id));
        INSERT INTO brain_import_current SELECT import_source,id FROM brain_note WHERE import_source IS NOT NULL;
        INSERT INTO brain_migration VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      `)
      // Stored Markdown with no attachment reference and no legacy row proves empty coverage.
      // Every other prior revision keeps its uncertainty; live files never fill historical gaps.
      const revisions=database.prepare('SELECT note,revision,markdown FROM brain_version WHERE NOT EXISTS(SELECT 1 FROM brain_attachment a WHERE a.note=brain_version.note AND a.revision=brain_version.revision)').all() as {note:string;revision:number;markdown:string}[]
      for(const revision of revisions)if(brainAttachmentReferences(revision.markdown).length===0)database.prepare("UPDATE brain_attachment_coverage SET state='complete' WHERE note=? AND revision=?").run(revision.note,revision.revision)
    }
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS brain_binding_no_update BEFORE UPDATE ON brain_attachment BEGIN SELECT RAISE(ABORT,'Brain attachment history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS brain_binding_no_delete BEFORE DELETE ON brain_attachment BEGIN SELECT RAISE(ABORT,'Brain attachment history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS brain_coverage_no_update BEFORE UPDATE ON brain_attachment_coverage BEGIN SELECT RAISE(ABORT,'Brain attachment coverage is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS brain_coverage_no_delete BEFORE DELETE ON brain_attachment_coverage BEGIN SELECT RAISE(ABORT,'Brain attachment coverage is append-only'); END;
    `)
  })()
}
