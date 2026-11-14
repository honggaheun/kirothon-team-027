import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

class Store:
    def __init__(self,path):
        if str(path)!=':memory:': Path(path).parent.mkdir(parents=True,exist_ok=True)
        self.lock=RLock()
        self.db=sqlite3.connect(str(path),check_same_thread=False,isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA busy_timeout=5000')
        self.db.execute('CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id))')
        self.db.execute('CREATE INDEX IF NOT EXISTS owner_lookup ON documents(collection,owner)')
    def get(self,collection,id,owner):
        with self.lock:
            row=self.db.execute('SELECT data FROM documents WHERE collection=? AND id=? AND owner=?',(collection,id,owner)).fetchone()
            return json.loads(row[0]) if row else None
    def list(self,collection,owner):
        with self.lock: return [json.loads(r[0]) for r in self.db.execute('SELECT data FROM documents WHERE collection=? AND owner=? ORDER BY rowid DESC',(collection,owner))]
    def all(self,collection):
        with self.lock: return [json.loads(r[0]) for r in self.db.execute('SELECT data FROM documents WHERE collection=?',(collection,))]
    def put(self,collection,doc):
        with self.lock:
            self.db.execute('INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET owner=excluded.owner,data=excluded.data',(collection,doc['id'],doc['ownerId'],json.dumps(doc,ensure_ascii=False)))
            return doc
    def delete(self,collection,id,owner):
        with self.lock: self.db.execute('DELETE FROM documents WHERE collection=? AND id=? AND owner=?',(collection,id,owner))
    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                yield
                self.db.execute('COMMIT')
            except BaseException:
                self.db.execute('ROLLBACK'); raise
    def close(self): self.db.close()
