import os
import re
import json
import uuid
import shutil
import threading
from datetime import datetime
from typing import Dict, Any, Optional, List

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Body
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, JSONResponse

from app.gedcom_service import (
    parse_gedcom_to_tree,
    sync_media_files,
    export_tree_to_gedcom,
    parse_gedcom_date,
    normalize_input_date_to_gedcom,
    EVENT_LABELS_IT,
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
MEDIA_DIR = os.path.join(DATA_DIR, "media")
TREE_JSON_PATH = os.path.join(DATA_DIR, "tree.json")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(MEDIA_DIR, exist_ok=True)

app = FastAPI(title="Ràdica — Albero Genealogico", version="1.0.0")

_tree_lock = threading.RLock()
_tree_cache: Optional[Dict[str, Any]] = None


def _find_initial_gedcom() -> Optional[str]:
    for folder in (DATA_DIR, BASE_DIR):
        if os.path.isdir(folder):
            for fname in os.listdir(folder):
                if fname.lower().endswith(".ged"):
                    return os.path.join(folder, fname)
    return None


def _load_tree() -> Dict[str, Any]:
    global _tree_cache
    with _tree_lock:
        if _tree_cache is not None:
            return _tree_cache

        if os.path.exists(TREE_JSON_PATH):
            with open(TREE_JSON_PATH, "r", encoding="utf-8") as f:
                _tree_cache = json.load(f)
            return _tree_cache

        # First-time bootstrap from any local GEDCOM file if present
        ged_path = _find_initial_gedcom()
        if ged_path and os.path.exists(ged_path):
            with open(ged_path, "rb") as f:
                raw_text = f.read().decode("utf-8-sig", errors="replace")
            _tree_cache = parse_gedcom_to_tree(raw_text)
            _save_tree_unlocked(_tree_cache)
            # Trigger media sync in background so startup is instant
            threading.Thread(target=_bg_sync_media, daemon=True).start()
            return _tree_cache

        _tree_cache = {
            "meta": {
                "title": "Ràdica",
                "source": "Ràdica Web",
                "gedcomVersion": "5.5.1",
                "defaultPersonId": None,
                "updatedAt": datetime.utcnow().isoformat() + "Z",
            },
            "individuals": {},
            "families": {},
            "sources": {},
        }
        _save_tree_unlocked(_tree_cache)
        return _tree_cache


def _save_tree_unlocked(tree: Dict[str, Any]):
    tree.setdefault("meta", {})["updatedAt"] = datetime.utcnow().isoformat() + "Z"
    tmp_path = TREE_JSON_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, TREE_JSON_PATH)


def _save_tree():
    with _tree_lock:
        if _tree_cache is not None:
            _save_tree_unlocked(_tree_cache)


def _bg_sync_media():
    with _tree_lock:
        tree = _load_tree()
    stats = sync_media_files(tree, MEDIA_DIR)
    if stats["downloaded"] > 0 or stats["cached"] > 0:
        with _tree_lock:
            _save_tree_unlocked(tree)


def _next_id(prefix: str, existing: Dict[str, Any]) -> str:
    max_num = 0
    for k in existing.keys():
        m = re.match(rf"^@{prefix}(\d+)@$", k)
        if m:
            num = int(m.group(1))
            if num < 500000 and num > max_num:
                max_num = num
            elif num >= 500000 and num > max_num:
                max_num = num
    return f"@{prefix}{max_num + 1}@"


def _format_event_dates(block: Dict[str, Any]) -> Dict[str, Any]:
    raw_in = block.get("date", "")
    ged_date = normalize_input_date_to_gedcom(raw_in)
    parsed = parse_gedcom_date(ged_date)
    block["date"] = parsed["raw"]
    block["dateDisplay"] = parsed["display"]
    block["year"] = parsed["year"]
    block["dateIso"] = parsed["iso"]
    return block


def _link_people(
    tree: Dict[str, Any],
    target_id: str,
    related_id: str,
    link_type: str,
    family_id: Optional[str] = None,
    marriage_date: str = "",
    marriage_place: str = "",
):
    individuals = tree["individuals"]
    families = tree["families"]

    if target_id not in individuals or related_id not in individuals:
        raise HTTPException(status_code=404, detail="Persona non trovata nell'albero")
    if target_id == related_id:
        raise HTTPException(status_code=400, detail="Impossibile collegare una persona a sé stessa")

    target = individuals[target_id]
    related = individuals[related_id]

    if link_type in ("father", "mother"):
        role = "husband" if link_type == "father" else "wife"
        # Check if target already has a FAMC family
        fam_id = family_id or (target["famc"][0] if target.get("famc") else None)
        fam = families.get(fam_id) if fam_id else None

        if not fam:
            fam_id = _next_id("F", families)
            fam = {
                "id": fam_id,
                "husband": None,
                "wife": None,
                "children": [target_id],
                "isDivorced": False,
                "marriage": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": "", "notes": ""},
                "divorce": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""},
                "events": [],
                "notes": "",
                "rin": "",
                "uid": str(uuid.uuid4()).upper(),
            }
            families[fam_id] = fam
            if fam_id not in target["famc"]:
                target["famc"].append(fam_id)

        # If previous parent was in that slot, remove fam_id from their fams
        old_parent_id = fam.get(role)
        if old_parent_id and old_parent_id != related_id and old_parent_id in individuals:
            if fam_id in individuals[old_parent_id]["fams"]:
                individuals[old_parent_id]["fams"].remove(fam_id)

        fam[role] = related_id
        if fam_id not in related["fams"]:
            related["fams"].append(fam_id)
        if target_id not in fam["children"]:
            fam["children"].append(target_id)
        if fam_id not in target["famc"]:
            target["famc"].append(fam_id)

    elif link_type == "spouse":
        # Check if a family between target and related already exists
        for fid in target.get("fams", []):
            f = families.get(fid)
            if f and ((f.get("husband") == target_id and f.get("wife") == related_id) or
                      (f.get("wife") == target_id and f.get("husband") == related_id)):
                return fid

        fam_id = _next_id("F", families)
        if target.get("sex") == "F" or (target.get("sex") != "M" and related.get("sex") == "M"):
            husb_id, wife_id = related_id, target_id
        else:
            husb_id, wife_id = target_id, related_id

        marr_block = _format_event_dates({"date": marriage_date, "place": marriage_place, "notes": ""})
        families[fam_id] = {
            "id": fam_id,
            "husband": husb_id,
            "wife": wife_id,
            "children": [],
            "isDivorced": False,
            "marriage": marr_block,
            "divorce": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""},
            "events": [],
            "notes": "",
            "rin": "",
            "uid": str(uuid.uuid4()).upper(),
        }
        if fam_id not in target["fams"]:
            target["fams"].append(fam_id)
        if fam_id not in related["fams"]:
            related["fams"].append(fam_id)
        return fam_id

    elif link_type == "child":
        fam_id = family_id or (target["fams"][0] if target.get("fams") else None)
        fam = families.get(fam_id) if fam_id else None
        if not fam:
            fam_id = _next_id("F", families)
            role = "wife" if target.get("sex") == "F" else "husband"
            fam = {
                "id": fam_id,
                "husband": target_id if role == "husband" else None,
                "wife": target_id if role == "wife" else None,
                "children": [],
                "isDivorced": False,
                "marriage": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": "", "notes": ""},
                "divorce": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""},
                "events": [],
                "notes": "",
                "rin": "",
                "uid": str(uuid.uuid4()).upper(),
            }
            families[fam_id] = fam
            if fam_id not in target["fams"]:
                target["fams"].append(fam_id)

        if related_id not in fam["children"]:
            fam["children"].append(related_id)
        if fam_id not in related["famc"]:
            related["famc"].append(fam_id)
        return fam_id

    elif link_type == "sibling":
        fam_id = family_id or (target["famc"][0] if target.get("famc") else None)
        fam = families.get(fam_id) if fam_id else None
        if not fam:
            fam_id = _next_id("F", families)
            fam = {
                "id": fam_id,
                "husband": None,
                "wife": None,
                "children": [target_id],
                "isDivorced": False,
                "marriage": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": "", "notes": ""},
                "divorce": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""},
                "events": [],
                "notes": "",
                "rin": "",
                "uid": str(uuid.uuid4()).upper(),
            }
            families[fam_id] = fam
            if fam_id not in target["famc"]:
                target["famc"].append(fam_id)

        if related_id not in fam["children"]:
            fam["children"].append(related_id)
        if fam_id not in related["famc"]:
            related["famc"].append(fam_id)
        return fam_id


@app.get("/api/tree")
def get_tree():
    tree = _load_tree()
    return tree


@app.put("/api/settings")
def update_settings(payload: Dict[str, Any] = Body(...)):
    with _tree_lock:
        tree = _load_tree()
        meta = tree.setdefault("meta", {})
        if "title" in payload:
            meta["title"] = str(payload["title"]).strip()
        if "defaultPersonId" in payload and payload["defaultPersonId"] in tree["individuals"]:
            meta["defaultPersonId"] = payload["defaultPersonId"]
        _save_tree_unlocked(tree)
        return {"status": "ok", "meta": meta}


@app.put("/api/person/{person_id}")
def update_person(person_id: str, payload: Dict[str, Any] = Body(...)):
    with _tree_lock:
        tree = _load_tree()
        if person_id not in tree["individuals"]:
            raise HTTPException(status_code=404, detail="Persona non trovata")

        p = tree["individuals"][person_id]
        for field in ("givenName", "surname", "marriedSurname", "prefix", "suffix", "occupation", "email", "address", "notes"):
            if field in payload:
                p[field] = str(payload[field] or "").strip()

        if "sex" in payload and payload["sex"] in ("M", "F", "U"):
            p["sex"] = payload["sex"]

        if "isDeceased" in payload:
            p["isDeceased"] = bool(payload["isDeceased"])

        p["fullName"] = " ".join(
            part for part in [p.get("prefix", ""), p.get("givenName", ""), p.get("surname", ""), p.get("suffix", "")] if part
        ).strip() or "Sconosciuto"

        for ev_key in ("birth", "death", "burial", "christening"):
            if ev_key in payload and isinstance(payload[ev_key], dict):
                blk = p.setdefault(ev_key, {})
                for sub_k, sub_v in payload[ev_key].items():
                    blk[sub_k] = sub_v
                _format_event_dates(blk)

        if p["death"].get("date") or p["death"].get("place") or p["death"].get("cause"):
            p["isDeceased"] = True

        if "events" in payload and isinstance(payload["events"], list):
            cleaned_events = []
            for ev in payload["events"]:
                tag = ev.get("tag", "EVEN")
                ev_copy = {
                    "id": ev.get("id") or str(uuid.uuid4())[:8],
                    "tag": tag,
                    "type": ev.get("type", ""),
                    "label": ev.get("label") or EVENT_LABELS_IT.get(tag, tag),
                    "value": ev.get("value", ""),
                    "date": ev.get("date", ""),
                    "place": ev.get("place", ""),
                    "age": ev.get("age", ""),
                    "cause": ev.get("cause", ""),
                    "address": ev.get("address", ""),
                    "email": ev.get("email", ""),
                    "notes": ev.get("notes", ""),
                }
                _format_event_dates(ev_copy)
                cleaned_events.append(ev_copy)
            p["events"] = cleaned_events

        if "primaryPhoto" in payload:
            p["primaryPhoto"] = payload["primaryPhoto"]

        _save_tree_unlocked(tree)
        return {"status": "ok", "person": p}


@app.post("/api/person")
def create_person(payload: Dict[str, Any] = Body(...)):
    with _tree_lock:
        tree = _load_tree()
        new_id = _next_id("I", tree["individuals"])

        givn = str(payload.get("givenName", "")).strip()
        surn = str(payload.get("surname", "")).strip()
        marnm = str(payload.get("marriedSurname", "")).strip()
        npfx = str(payload.get("prefix", "")).strip()
        nsfx = str(payload.get("suffix", "")).strip()
        sex = payload.get("sex", "U")
        if sex not in ("M", "F", "U"):
            sex = "U"

        full_name = " ".join(part for part in [npfx, givn, surn, nsfx] if part).strip() or "Nuova Persona"

        birth_blk = _format_event_dates({
            "date": str(payload.get("birthDate", "")).strip(),
            "place": str(payload.get("birthPlace", "")).strip(),
        })
        death_blk = _format_event_dates({
            "date": str(payload.get("deathDate", "")).strip(),
            "place": str(payload.get("deathPlace", "")).strip(),
            "cause": str(payload.get("deathCause", "")).strip(),
            "age": str(payload.get("deathAge", "")).strip(),
        })
        is_deceased = bool(payload.get("isDeceased")) or bool(death_blk["date"] or death_blk["place"] or death_blk["cause"])

        new_person = {
            "id": new_id,
            "givenName": givn,
            "surname": surn,
            "marriedSurname": marnm,
            "prefix": npfx,
            "suffix": nsfx,
            "fullName": full_name,
            "sex": sex,
            "isDeceased": is_deceased,
            "birth": birth_blk,
            "death": death_blk,
            "burial": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""},
            "christening": {"date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""},
            "occupation": str(payload.get("occupation", "")).strip(),
            "email": str(payload.get("email", "")).strip(),
            "address": str(payload.get("address", "")).strip(),
            "notes": str(payload.get("notes", "")).strip(),
            "events": [],
            "media": [],
            "primaryPhoto": None,
            "famc": [],
            "fams": [],
            "citations": [],
            "rin": f"MH:{new_id.strip('@')}",
            "uid": str(uuid.uuid4()).upper(),
        }

        tree["individuals"][new_id] = new_person

        # Optional immediate relationship link
        link_type = payload.get("linkType")
        target_id = payload.get("targetPersonId")
        family_id = payload.get("familyId")
        if link_type and target_id:
            _link_people(
                tree,
                target_id=target_id,
                related_id=new_id,
                link_type=link_type,
                family_id=family_id,
                marriage_date=str(payload.get("marriageDate", "")),
                marriage_place=str(payload.get("marriagePlace", "")),
            )

        _save_tree_unlocked(tree)
        return {"status": "ok", "person": new_person, "tree": tree}


@app.delete("/api/person/{person_id}")
def delete_person(person_id: str):
    with _tree_lock:
        tree = _load_tree()
        if person_id not in tree["individuals"]:
            raise HTTPException(status_code=404, detail="Persona non trovata")

        # Clean up references in all families
        empty_fams = []
        for fid, fam in tree["families"].items():
            if fam.get("husband") == person_id:
                fam["husband"] = None
            if fam.get("wife") == person_id:
                fam["wife"] = None
            if person_id in fam.get("children", []):
                fam["children"].remove(person_id)

            # Check if family has become trivial/empty
            if not fam.get("husband") and not fam.get("wife") and len(fam.get("children", [])) == 0:
                empty_fams.append(fid)

        for fid in empty_fams:
            del tree["families"][fid]
            for p in tree["individuals"].values():
                if fid in p.get("fams", []):
                    p["fams"].remove(fid)
                if fid in p.get("famc", []):
                    p["famc"].remove(fid)

        del tree["individuals"][person_id]
        if tree["meta"].get("defaultPersonId") == person_id:
            tree["meta"]["defaultPersonId"] = next(iter(tree["individuals"].keys()), None)

        _save_tree_unlocked(tree)
        return {"status": "ok", "tree": tree}


@app.post("/api/relationship")
def add_relationship(payload: Dict[str, Any] = Body(...)):
    with _tree_lock:
        tree = _load_tree()
        target_id = payload.get("targetPersonId")
        related_id = payload.get("relatedPersonId")
        link_type = payload.get("linkType")
        family_id = payload.get("familyId")
        if not target_id or not related_id or not link_type:
            raise HTTPException(status_code=400, detail="Parametri mancanti")

        _link_people(
            tree,
            target_id=target_id,
            related_id=related_id,
            link_type=link_type,
            family_id=family_id,
            marriage_date=str(payload.get("marriageDate", "")),
            marriage_place=str(payload.get("marriagePlace", "")),
        )
        _save_tree_unlocked(tree)
        return {"status": "ok", "tree": tree}


@app.post("/api/relationship/unlink")
def unlink_relationship(payload: Dict[str, Any] = Body(...)):
    with _tree_lock:
        tree = _load_tree()
        family_id = payload.get("familyId")
        person_id = payload.get("personId")
        role = payload.get("role")  # 'husband', 'wife', 'child', or 'delete_family'

        if family_id not in tree["families"]:
            raise HTTPException(status_code=404, detail="Famiglia non trovata")

        fam = tree["families"][family_id]
        individuals = tree["individuals"]

        if role == "delete_family":
            for pid in [fam.get("husband"), fam.get("wife")]:
                if pid and pid in individuals and family_id in individuals[pid]["fams"]:
                    individuals[pid]["fams"].remove(family_id)
            for cid in fam.get("children", []):
                if cid in individuals and family_id in individuals[cid]["famc"]:
                    individuals[cid]["famc"].remove(family_id)
            del tree["families"][family_id]
        elif role in ("husband", "wife"):
            pid = fam.get(role)
            fam[role] = None
            if pid and pid in individuals and family_id in individuals[pid]["fams"]:
                individuals[pid]["fams"].remove(family_id)
        elif role == "child" and person_id:
            if person_id in fam.get("children", []):
                fam["children"].remove(person_id)
            if person_id in individuals and family_id in individuals[person_id]["famc"]:
                individuals[person_id]["famc"].remove(family_id)

        # Clean up if empty
        if family_id in tree["families"]:
            f = tree["families"][family_id]
            if not f.get("husband") and not f.get("wife") and not f.get("children"):
                del tree["families"][family_id]

        _save_tree_unlocked(tree)
        return {"status": "ok", "tree": tree}


@app.put("/api/family/{family_id}")
def update_family(family_id: str, payload: Dict[str, Any] = Body(...)):
    with _tree_lock:
        tree = _load_tree()
        if family_id not in tree["families"]:
            raise HTTPException(status_code=404, detail="Famiglia non trovata")

        fam = tree["families"][family_id]
        if "isDivorced" in payload:
            fam["isDivorced"] = bool(payload["isDivorced"])
        if "notes" in payload:
            fam["notes"] = str(payload["notes"] or "").strip()

        if "marriage" in payload and isinstance(payload["marriage"], dict):
            m = fam.setdefault("marriage", {})
            for k, v in payload["marriage"].items():
                m[k] = v
            _format_event_dates(m)

        if "divorce" in payload and isinstance(payload["divorce"], dict):
            d = fam.setdefault("divorce", {})
            for k, v in payload["divorce"].items():
                d[k] = v
            _format_event_dates(d)
            if d.get("date") or d.get("place"):
                fam["isDivorced"] = True

        _save_tree_unlocked(tree)
        return {"status": "ok", "family": fam, "tree": tree}


@app.post("/api/person/{person_id}/media")
async def upload_person_media(
    person_id: str,
    file: UploadFile = File(...),
    title: str = Form(""),
    set_primary: str = Form("true"),
):
    with _tree_lock:
        tree = _load_tree()
        if person_id not in tree["individuals"]:
            raise HTTPException(status_code=404, detail="Persona non trovata")

        orig_name = file.filename or "upload.jpg"
        ext = os.path.splitext(orig_name)[1].lower().lstrip(".")
        if ext not in ("jpg", "jpeg", "png", "gif", "webp", "pdf"):
            ext = "jpg"

        media_id = f"upload_{uuid.uuid4().hex[:10]}"
        local_fname = f"{person_id.strip('@')}_{media_id}.{ext}"
        local_path = os.path.join(MEDIA_DIR, local_fname)

        content = await file.read()
        with open(local_path, "wb") as f:
            f.write(content)

        is_prim = set_primary.lower() in ("true", "1", "yes") and ext != "pdf"
        person = tree["individuals"][person_id]

        if is_prim:
            for m in person.get("media", []):
                m["isPrimary"] = False

        media_item = {
            "id": media_id,
            "form": ext,
            "originalUrl": f"/media/{local_fname}",
            "localFilename": local_fname,
            "url": f"/media/{local_fname}",
            "title": title.strip() or orig_name,
            "isPrimary": is_prim,
            "isPersonalPhoto": is_prim,
            "isCutout": False,
            "isParentPhoto": False,
            "parentRin": "",
            "position": "",
            "filesize": len(content),
        }
        person.setdefault("media", []).insert(0, media_item)
        if is_prim or not person.get("primaryPhoto"):
            if ext != "pdf":
                person["primaryPhoto"] = media_item["url"]

        _save_tree_unlocked(tree)
        return {"status": "ok", "media": media_item, "person": person}


@app.put("/api/person/{person_id}/primary-media")
def set_primary_media(person_id: str, payload: Dict[str, Any] = Body(...)):
    with _tree_lock:
        tree = _load_tree()
        if person_id not in tree["individuals"]:
            raise HTTPException(status_code=404, detail="Persona non trovata")

        media_id = payload.get("mediaId")
        person = tree["individuals"][person_id]
        chosen_url = None
        for m in person.get("media", []):
            if m.get("id") == media_id and m.get("form") != "pdf":
                m["isPrimary"] = True
                chosen_url = m["url"]
            else:
                m["isPrimary"] = False

        if chosen_url:
            person["primaryPhoto"] = chosen_url
        _save_tree_unlocked(tree)
        return {"status": "ok", "person": person}


@app.delete("/api/person/{person_id}/media/{media_id}")
def delete_person_media(person_id: str, media_id: str):
    with _tree_lock:
        tree = _load_tree()
        if person_id not in tree["individuals"]:
            raise HTTPException(status_code=404, detail="Persona non trovata")

        person = tree["individuals"][person_id]
        removed = None
        new_media = []
        for m in person.get("media", []):
            if m.get("id") == media_id:
                removed = m
            else:
                new_media.append(m)
        person["media"] = new_media

        # Recompute primaryPhoto
        prim = None
        for m in new_media:
            if m.get("isPrimary") and m.get("form") != "pdf":
                prim = m["url"]
                break
        if not prim:
            for m in new_media:
                if m.get("form") in ("jpg", "jpeg", "png", "webp"):
                    prim = m["url"]
                    break
        person["primaryPhoto"] = prim

        _save_tree_unlocked(tree)
        return {"status": "ok", "person": person}


@app.post("/api/gedcom/import")
async def import_gedcom(file: UploadFile = File(...)):
    global _tree_cache
    raw_bytes = await file.read()
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw_bytes.decode("latin-1", errors="replace")

    new_tree = parse_gedcom_to_tree(text)
    with _tree_lock:
        # Backup old tree if it existed
        if os.path.exists(TREE_JSON_PATH):
            ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            shutil.copy2(TREE_JSON_PATH, os.path.join(DATA_DIR, f"tree_backup_{ts}.json"))
        _tree_cache = new_tree
        _save_tree_unlocked(_tree_cache)

    # Sync remote media in background
    threading.Thread(target=_bg_sync_media, daemon=True).start()
    return {"status": "ok", "tree": new_tree}


@app.get("/api/gedcom/export")
def export_gedcom():
    tree = _load_tree()
    ged_content = export_tree_to_gedcom(tree)
    safe_title = re.sub(r"[^a-zA-Z0-9_-]", "_", tree.get("meta", {}).get("title", "albero_genealogico"))
    date_tag = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"{safe_title}_{date_tag}.ged"
    return Response(
        content=ged_content.encode("utf-8-sig"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/media/sync")
def trigger_media_sync():
    with _tree_lock:
        tree = _load_tree()
    stats = sync_media_files(tree, MEDIA_DIR)
    with _tree_lock:
        _save_tree_unlocked(tree)
    return {"status": "ok", "stats": stats, "tree": tree}


# Mount media directory and static assets
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
