#!/usr/bin/env python3
"""Offline SQLite FTS5 index for bounded local documents, no embeddings or network."""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import zipfile
import xml.etree.ElementTree as ET

HOME = Path(os.environ.get("AEGIS_HOME", str(Path.home()))).resolve()
DATABASE = HOME / ".aegis-local" / "documents.sqlite3"
TEXT_TYPES = {".md",".txt",".csv",".json",".py",".js",".jsx",".ts",".tsx",".html",".css",".log",".ipynb"}
OFFICE_TYPES = {".docx",".xlsx",".pptx"}
MAX_DOCUMENTS=2500
MAX_BYTES=8*1024*1024
MAX_INDEX_CHARS=22000
BAD_DIRS={".git",".obsidian",".trash","node_modules","__pycache__",".venv","Library","Applications"}
OFFICE_MEMBER_PREFIX = {".docx":("word/document.xml",),".pptx":("ppt/slides/slide",),".xlsx":("xl/sharedStrings.xml","xl/worksheets/sheet")}


def inside(root: Path, target: Path) -> bool:
    return target == root or root in target.parents

def configure():
    DATABASE.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    conn=sqlite3.connect(DATABASE,timeout=20)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER)")
    conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(path UNINDEXED, text, tokenize='unicode61')")
    return conn

def roots_from_payload(raw):
    if not isinstance(raw,dict): raise ValueError("Expected configuration.")
    roots=[]
    for root in raw.get("roots",[])[:10]:
        if not isinstance(root,str): continue
        file=Path(root).expanduser()
        if not file.is_dir(): continue
        if file.is_symlink(): continue
        actual=file.resolve()
        if not inside(HOME,actual):continue
        roots.append(actual)
    return roots

def office_text(file:Path,ext:str)->str:
    parts=[]
    with zipfile.ZipFile(file) as archive:
        members=archive.infolist()
        if len(members)>1000:raise ValueError("Office document has too many parts.")
        for member in members:
            name=member.filename
            if not name.endswith(".xml") or not any(name.startswith(p) for p in OFFICE_MEMBER_PREFIX[ext]):
                continue
            if member.file_size>1500000:continue
            try:
                data=archive.read(member)
                tree=ET.fromstring(data)
                parts.extend((tag.text or "") for tag in tree.iter() if tag.tag.endswith("}t") or tag.tag.endswith("}v"))
            except (ET.ParseError,ValueError):continue
            if sum(map(len,parts))>MAX_INDEX_CHARS:break
    return " ".join(parts)[:MAX_INDEX_CHARS]

def read_content(file:Path)->str:
    ext=file.suffix.lower()
    if ext in TEXT_TYPES:return file.read_text(encoding="utf-8",errors="replace")[:MAX_INDEX_CHARS]
    if ext in OFFICE_TYPES:return office_text(file,ext)
    if ext==".pdf":
        binary="/opt/homebrew/bin/pdftotext" if Path("/opt/homebrew/bin/pdftotext").is_file() else "/usr/local/bin/pdftotext"
        if not Path(binary).is_file():return ""
        try:
            result=subprocess.run([binary,"-f","1","-l","15","-layout",str(file),"-"],
                    capture_output=True,text=True,timeout=9,check=False)
            return result.stdout[:MAX_INDEX_CHARS] if result.returncode==0 else ""
        except (OSError,subprocess.TimeoutExpired):return ""
    return ""

def rebuild(raw):
    roots=roots_from_payload(raw)
    excluded=Path(raw.get("exclude",str(HOME/"Documents/Obsidian/aegis"))).expanduser().resolve()
    conn=configure()
    started=time.monotonic();found={};errors=0
    for root in roots:
        for folder,dirs,files in os.walk(root,followlinks=False):
            current=Path(folder)
            if time.monotonic()-started>40 or len(found)>=MAX_DOCUMENTS:break
            dirs[:]=[name for name in dirs if name not in BAD_DIRS and not name.startswith(".") and
                not (current/name).is_symlink() and
                not inside(excluded,(current/name).resolve())]
            for name in files:
                if len(found)>=MAX_DOCUMENTS or time.monotonic()-started>40:break
                file=current/name
                if name.startswith(".") or file.is_symlink():continue
                if inside(excluded,file.resolve()):continue
                if file.suffix.lower() not in TEXT_TYPES|OFFICE_TYPES|{".pdf"}:continue
                try:
                    stat=file.stat()
                    if stat.st_size<1 or stat.st_size>MAX_BYTES:continue
                    content=read_content(file)
                    if not content.strip():continue
                    found[str(file)] = (stat.st_mtime,stat.st_size,content)
                except (OSError,ValueError,zipfile.BadZipFile):errors+=1
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM files")
        conn.execute("DELETE FROM words")
        for file,(mtime,size,content) in found.items():
            conn.execute("INSERT INTO files VALUES (?,?,?)",(file,mtime,size))
            conn.execute("INSERT INTO words(path,text) VALUES (?,?)",(file,content))
        conn.commit()
    except:conn.rollback();raise
    finally:conn.close()
    return {"indexed":len(found),"errors":errors,"elapsedSeconds":round(time.monotonic()-started,2),"partial":len(found)>=MAX_DOCUMENTS or time.monotonic()-started>40}

def search(raw):
    query=raw.get("query","")
    if not isinstance(query,str) or len(query)>100 or not query.strip():raise ValueError("Invalid query")
    words=re.findall(r"[\wÀ-ÿ]{2,}",query)[:12]
    if not words:return {"results":[],"count":0}
    if not DATABASE.is_file():return {"results":[],"count":0,"status":"no index yet"}
    conn=configure()
    try:
        expression=" AND ".join('"'+w.replace('"','')+'"' for w in words)
        rows=conn.execute(
            "SELECT path,snippet(words,1,'[',']','...',16) FROM words WHERE words MATCH ? ORDER BY bm25(words) LIMIT 18",
            (expression,)).fetchall()
    finally:conn.close()
    return {"results":[{"path":p,"excerpt":snippet[:260]} for p,snippet in rows],"count":len(rows)}

def main():
    try:
        if len(sys.argv)!=2 or sys.argv[1] not in ("rebuild","search"):raise ValueError("Use rebuild or search")
        payload=json.load(sys.stdin)
        output=rebuild(payload) if sys.argv[1]=="rebuild" else search(payload)
        print(json.dumps(output,ensure_ascii=False))
    except (OSError,sqlite3.Error,ValueError) as error:
        print(json.dumps({"error":str(error)[:400]}))
        return 1
    return 0

if __name__=="__main__":raise SystemExit(main())
