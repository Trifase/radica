import os
import re
import json
import uuid
import hashlib
import urllib.request
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple

MONTHS_MAP = {
    "JAN": (1, "Gen"),
    "FEB": (2, "Feb"),
    "MAR": (3, "Mar"),
    "APR": (4, "Apr"),
    "MAY": (5, "Mag"),
    "JUN": (6, "Giu"),
    "JUL": (7, "Lug"),
    "AUG": (8, "Ago"),
    "SEP": (9, "Set"),
    "OCT": (10, "Ott"),
    "NOV": (11, "Nov"),
    "DEC": (12, "Dic"),
}

ITALIAN_TO_GED_MONTH = {
    "GEN": "JAN", "GENNAIO": "JAN",
    "FEB": "FEB", "FEBBRAIO": "FEB",
    "MAR": "MAR", "MARZO": "MAR",
    "APR": "APR", "APRILE": "APR",
    "MAG": "MAY", "MAGGIO": "MAY",
    "GIU": "JUN", "GIUGNO": "JUN",
    "LUG": "JUL", "LUGLIO": "JUL",
    "AGO": "AUG", "AGOSTO": "AUG",
    "SET": "SEP", "SETTEMBRE": "SEP",
    "OTT": "OCT", "OTTOBRE": "OCT",
    "NOV": "NOV", "NOVEMBRE": "NOV",
    "DIC": "DEC", "DICEMBRE": "DEC",
}

MODIFIERS_IT = {
    "ABT": "circa",
    "ABOUT": "circa",
    "EST": "stimato",
    "CAL": "calcolato",
    "BEF": "prima del",
    "BEFORE": "prima del",
    "AFT": "dopo il",
    "AFTER": "dopo il",
    "FROM": "dal",
    "TO": "al",
    "BET": "tra",
    "AND": "e",
}

EVENT_LABELS_IT = {
    "BIRT": "Nascita",
    "DEAT": "Decesso",
    "BURI": "Sepoltura",
    "CHR": "Battesimo",
    "BAPM": "Battesimo",
    "RESI": "Residenza",
    "OCCU": "Occupazione",
    "EDUC": "Istruzione",
    "EMIG": "Emigrazione",
    "IMMI": "Immigrazione",
    "NATU": "Naturalizzazione",
    "CENS": "Censimento",
    "EVEN": "Evento",
    "MARR": "Matrimonio",
    "DIV": "Divorzio",
    "ENGA": "Fidanzamento",
    "MARL": "Licenza matrimoniale",
}


def parse_gedcom_date(raw_date: str) -> Dict[str, Any]:
    """Parse a GEDCOM date string into structured fields and Italian display text."""
    if not raw_date:
        return {"raw": "", "display": "", "year": None, "iso": ""}
    s = raw_date.strip()
    year_match = re.search(r"\b(\d{4})\b", s)
    year = int(year_match.group(1)) if year_match else None

    # Format display in Italian
    tokens = s.split()
    display_tokens = []
    day_num = None
    month_num = None
    for tok in tokens:
        up = tok.upper()
        if up in MODIFIERS_IT:
            display_tokens.append(MODIFIERS_IT[up])
        elif up in MONTHS_MAP:
            month_num, it_m = MONTHS_MAP[up]
            display_tokens.append(it_m)
        elif re.match(r"^\d{1,2}$", tok) and day_num is None:
            day_num = int(tok)
            display_tokens.append(tok)
        else:
            display_tokens.append(tok)

    display = " ".join(display_tokens)
    iso = ""
    if year and month_num and day_num and not any(t.upper() in MODIFIERS_IT for t in tokens):
        iso = f"{year:04d}-{month_num:02d}-{day_num:02d}"
    elif year and month_num and not day_num:
        iso = f"{year:04d}-{month_num:02d}"
    elif year:
        iso = f"{year:04d}"

    return {
        "raw": s,
        "display": display,
        "year": year,
        "iso": iso,
    }


def normalize_input_date_to_gedcom(date_str: str) -> str:
    """Convert an ISO date (YYYY-MM-DD) or Italian date string to standard GEDCOM date."""
    if not date_str:
        return ""
    s = date_str.strip()
    # Check YYYY-MM-DD
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        ged_m = next((k for k, v in MONTHS_MAP.items() if v[0] == mo), "JAN")
        return f"{d} {ged_m} {y}"
    # Check DD/MM/YYYY
    m2 = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
    if m2:
        d, mo, y = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
        ged_m = next((k for k, v in MONTHS_MAP.items() if v[0] == mo), "JAN")
        return f"{d} {ged_m} {y}"
    # Replace Italian month names or modifiers if present
    tokens = s.split()
    out = []
    for t in tokens:
        up = t.upper().rstrip(".")
        if up in ITALIAN_TO_GED_MONTH:
            out.append(ITALIAN_TO_GED_MONTH[up])
        elif up == "CIRCA":
            out.append("ABT")
        elif up in ("PRIMA", "PRIMA DEL"):
            out.append("BEF")
        elif up in ("DOPO", "DOPO IL"):
            out.append("AFT")
        else:
            out.append(t)
    return " ".join(out)


class GedcomNode:
    def __init__(self, level: int, tag: str, value: str = "", xref: str = ""):
        self.level = level
        self.tag = tag
        self.value = value
        self.xref = xref
        self.children: List["GedcomNode"] = []

    def add_child(self, node: "GedcomNode"):
        self.children.append(node)

    def get_first(self, tag: str) -> Optional["GedcomNode"]:
        for c in self.children:
            if c.tag == tag:
                return c
        return None

    def get_all(self, tag: str) -> List["GedcomNode"]:
        return [c for c in self.children if c.tag == tag]

    def get_text(self, tag: str, default: str = "") -> str:
        node = self.get_first(tag)
        if not node:
            return default
        return node.full_text()

    def full_text(self) -> str:
        parts = [self.value] if self.value else []
        for c in self.children:
            if c.tag == "CONC":
                if parts:
                    parts[-1] = parts[-1] + c.value
                else:
                    parts.append(c.value)
            elif c.tag == "CONT":
                parts.append(c.value)
        return "\n".join(parts).strip()


def parse_gedcom_lines_to_ast(text: str) -> List[GedcomNode]:
    lines = text.splitlines()
    roots: List[GedcomNode] = []
    stack: List[GedcomNode] = []

    for raw_line in lines:
        line = raw_line.strip("\r\n")
        if not line.strip():
            continue
        m = re.match(r"^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s+(.*))?$", line)
        if not m:
            continue
        level = int(m.group(1))
        xref = m.group(2) or ""
        tag = m.group(3).upper()
        value = m.group(4) or ""

        # In GEDCOM, values sometimes have @@ escaped as @ (e.g., emails in MyHeritage)
        value = value.replace("@@", "@")

        node = GedcomNode(level=level, tag=tag, value=value, xref=xref)

        if level == 0:
            roots.append(node)
            stack = [node]
        else:
            while stack and stack[-1].level >= level:
                stack.pop()
            if stack:
                stack[-1].add_child(node)
            stack.append(node)

    return roots


def parse_event_node(node: GedcomNode) -> Dict[str, Any]:
    raw_date = node.get_text("DATE")
    date_info = parse_gedcom_date(raw_date)
    place = node.get_text("PLAC")
    age = node.get_text("AGE")
    cause = node.get_text("CAUS")
    ev_type = node.get_text("TYPE")
    addr = node.get_text("ADDR")
    email = node.get_text("EMAIL")
    notes = [n.full_text() for n in node.get_all("NOTE") if n.full_text()]
    label = ev_type if (node.tag == "EVEN" and ev_type) else EVENT_LABELS_IT.get(node.tag, node.tag)

    return {
        "id": str(uuid.uuid4())[:8],
        "tag": node.tag,
        "type": ev_type,
        "label": label,
        "value": node.value if node.value != "Y" else "",
        "date": date_info["raw"],
        "dateDisplay": date_info["display"],
        "year": date_info["year"],
        "dateIso": date_info["iso"],
        "place": place,
        "age": age,
        "cause": cause,
        "address": addr,
        "email": email,
        "notes": "\n".join(notes),
    }


def parse_obje_node(node: GedcomNode, owner_id: str, index: int) -> Dict[str, Any]:
    form = node.get_text("FORM").lower()
    file_url = node.get_text("FILE")
    title = node.get_text("TITL")
    rin = node.get_text("_PHOTO_RIN") or f"{owner_id}_M{index}"
    parent_rin = node.get_text("_PARENTRIN")
    position = node.get_text("_POSITION")
    is_prim = node.get_text("_PRIM") == "Y"
    is_personal = node.get_text("_PERSONALPHOTO") == "Y"
    is_cutout = node.get_text("_CUTOUT") == "Y"
    is_parent_photo = node.get_text("_PARENTPHOTO") == "Y"
    filesize = node.get_text("_FILESIZE")

    # Determine deterministic local filename if remote URL
    ext = form if form in ("jpg", "jpeg", "png", "gif", "webp", "pdf") else "jpg"
    url_hash = hashlib.md5((file_url or rin).encode("utf-8")).hexdigest()[:12]
    safe_rin = re.sub(r"[^a-zA-Z0-9_-]", "_", rin)
    local_filename = f"{owner_id.strip('@')}_{safe_rin}_{url_hash}.{ext}"

    return {
        "id": safe_rin or f"media_{url_hash}",
        "form": ext,
        "originalUrl": file_url,
        "localFilename": local_filename,
        "url": file_url,  # Will be replaced by /media/<localFilename> once downloaded
        "title": title or (
            "Foto profilo" if is_prim else ("Foto originale" if is_parent_photo else local_filename)
        ),
        "isPrimary": is_prim,
        "isPersonalPhoto": is_personal,
        "isCutout": is_cutout,
        "isParentPhoto": is_parent_photo,
        "parentRin": parent_rin,
        "position": position,
        "filesize": int(filesize) if filesize.isdigit() else None,
    }


def parse_gedcom_to_tree(gedcom_text: str) -> Dict[str, Any]:
    roots = parse_gedcom_lines_to_ast(gedcom_text)

    meta: Dict[str, Any] = {
        "title": "Albero Genealogico",
        "source": "MyHeritage",
        "gedcomVersion": "5.5.1",
        "exportedDate": "",
        "fileDescription": "",
        "defaultPersonId": None,
        "updatedAt": datetime.utcnow().isoformat() + "Z",
    }

    individuals: Dict[str, Dict[str, Any]] = {}
    families: Dict[str, Dict[str, Any]] = {}
    sources: Dict[str, Dict[str, Any]] = {}

    for root in roots:
        if root.tag == "HEAD":
            meta["exportedDate"] = root.get_text("DATE")
            file_desc = root.get_text("FILE")
            meta["fileDescription"] = file_desc
            m_name = re.search(r"in\s+(.+?)\s+on\s+", file_desc)
            if m_name:
                meta["title"] = m_name.group(1).strip()

        elif root.tag == "SOUR" and root.xref:
            sources[root.xref] = {
                "id": root.xref,
                "title": root.get_text("TITL") or root.get_text("NAME") or root.xref,
                "author": root.get_text("AUTH"),
                "publisher": root.get_text("PUBL"),
                "text": root.get_text("TEXT"),
                "rin": root.get_text("RIN"),
            }

        elif root.tag == "INDI" and root.xref:
            xref = root.xref
            name_node = root.get_first("NAME")
            raw_name = name_node.value if name_node else ""
            givn = name_node.get_text("GIVN") if name_node else ""
            surn = name_node.get_text("SURN") if name_node else ""
            marnm = name_node.get_text("_MARNM") if name_node else ""
            npfx = name_node.get_text("NPFX") if name_node else ""
            nsfx = name_node.get_text("NSFX") if name_node else ""

            if not givn and not surn and raw_name:
                m = re.match(r"^([^/]*?)\s*/([^/]*)/\s*(.*)$", raw_name)
                if m:
                    givn = m.group(1).strip()
                    surn = m.group(2).strip()
                    if not nsfx and m.group(3).strip():
                        nsfx = m.group(3).strip()
                else:
                    givn = raw_name.strip()

            sex = root.get_text("SEX", "U").upper()
            if sex not in ("M", "F", "U"):
                sex = "U"

            # Birth
            birt_node = root.get_first("BIRT")
            birth_info = parse_event_node(birt_node) if birt_node else {
                "date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""
            }

            # Death
            deat_node = root.get_first("DEAT")
            is_deceased = deat_node is not None
            death_info = parse_event_node(deat_node) if deat_node else {
                "date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": "", "cause": "", "age": ""
            }

            # Burial
            buri_node = root.get_first("BURI")
            burial_info = parse_event_node(buri_node) if buri_node else {
                "date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""
            }

            # Christening / Baptism
            chr_node = root.get_first("CHR") or root.get_first("BAPM")
            chr_info = parse_event_node(chr_node) if chr_node else {
                "date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""
            }

            # Occupation, Residence, Email, Education
            occu_nodes = root.get_all("OCCU")
            occupations = [o.value for o in occu_nodes if o.value]
            occupation_str = ", ".join(occupations)

            resi_nodes = root.get_all("RESI")
            email = ""
            address = ""
            for r in resi_nodes:
                if not email and r.get_text("EMAIL"):
                    email = r.get_text("EMAIL")
                if not address and (r.get_text("ADDR") or r.get_text("PLAC") or r.value):
                    address = r.get_text("ADDR") or r.get_text("PLAC") or r.value

            # All events list
            event_tags = ("BIRT", "CHR", "BAPM", "DEAT", "BURI", "OCCU", "EDUC", "RESI", "EMIG", "IMMI", "NATU", "CENS", "EVEN")
            events = []
            for c in root.children:
                if c.tag in event_tags:
                    events.append(parse_event_node(c))

            # Notes
            notes_list = [n.full_text() for n in root.get_all("NOTE") if n.full_text()]
            notes_text = "\n\n".join(notes_list)

            # Media
            obje_nodes = root.get_all("OBJE")
            media_items = [parse_obje_node(o, xref, idx) for idx, o in enumerate(obje_nodes)]

            primary_photo = None
            for m_item in media_items:
                if m_item["isPrimary"] and m_item["form"] != "pdf":
                    primary_photo = m_item["url"]
                    break
            if not primary_photo:
                for m_item in media_items:
                    if m_item["form"] in ("jpg", "jpeg", "png", "webp"):
                        primary_photo = m_item["url"]
                        break

            # Family links
            famc = [c.value for c in root.get_all("FAMC") if c.value]
            fams = [c.value for c in root.get_all("FAMS") if c.value]

            # Sources citations
            citations = []
            for s_node in root.get_all("SOUR"):
                data_node = s_node.get_first("DATA")
                citations.append({
                    "sourceId": s_node.value,
                    "page": s_node.get_text("PAGE"),
                    "text": data_node.get_text("TEXT") if data_node else "",
                    "date": data_node.get_text("DATE") if data_node else "",
                    "note": s_node.get_text("NOTE"),
                })

            full_name = " ".join(p for p in [npfx, givn, surn, nsfx] if p).strip() or "Sconosciuto"

            individuals[xref] = {
                "id": xref,
                "givenName": givn,
                "surname": surn,
                "marriedSurname": marnm,
                "prefix": npfx,
                "suffix": nsfx,
                "fullName": full_name,
                "sex": sex,
                "isDeceased": is_deceased,
                "birth": {
                    "date": birth_info.get("date", ""),
                    "dateDisplay": birth_info.get("dateDisplay", ""),
                    "year": birth_info.get("year"),
                    "dateIso": birth_info.get("dateIso", ""),
                    "place": birth_info.get("place", ""),
                },
                "death": {
                    "date": death_info.get("date", ""),
                    "dateDisplay": death_info.get("dateDisplay", ""),
                    "year": death_info.get("year"),
                    "dateIso": death_info.get("dateIso", ""),
                    "place": death_info.get("place", ""),
                    "cause": death_info.get("cause", ""),
                    "age": death_info.get("age", ""),
                },
                "burial": {
                    "date": burial_info.get("date", ""),
                    "dateDisplay": burial_info.get("dateDisplay", ""),
                    "year": burial_info.get("year"),
                    "dateIso": burial_info.get("dateIso", ""),
                    "place": burial_info.get("place", ""),
                },
                "christening": {
                    "date": chr_info.get("date", ""),
                    "dateDisplay": chr_info.get("dateDisplay", ""),
                    "year": chr_info.get("year"),
                    "dateIso": chr_info.get("dateIso", ""),
                    "place": chr_info.get("place", ""),
                },
                "occupation": occupation_str,
                "email": email,
                "address": address,
                "notes": notes_text,
                "events": events,
                "media": media_items,
                "primaryPhoto": primary_photo,
                "famc": famc,
                "fams": fams,
                "citations": citations,
                "rin": root.get_text("RIN"),
                "uid": root.get_text("_UID"),
            }

        elif root.tag == "FAM" and root.xref:
            xref = root.xref
            husb = root.get_text("HUSB")
            wife = root.get_text("WIFE")
            children = [c.value for c in root.get_all("CHIL") if c.value]

            marr_node = root.get_first("MARR")
            marr_info = parse_event_node(marr_node) if marr_node else {
                "date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": "", "notes": ""
            }

            div_node = root.get_first("DIV")
            is_divorced = div_node is not None
            div_info = parse_event_node(div_node) if div_node else {
                "date": "", "dateDisplay": "", "year": None, "dateIso": "", "place": ""
            }

            fam_events = []
            for c in root.children:
                if c.tag in ("MARR", "DIV", "ENGA", "MARL", "EVEN"):
                    fam_events.append(parse_event_node(c))

            fam_notes = "\n\n".join(n.full_text() for n in root.get_all("NOTE") if n.full_text())

            families[xref] = {
                "id": xref,
                "husband": husb or None,
                "wife": wife or None,
                "children": children,
                "isDivorced": is_divorced,
                "marriage": {
                    "date": marr_info.get("date", ""),
                    "dateDisplay": marr_info.get("dateDisplay", ""),
                    "year": marr_info.get("year"),
                    "dateIso": marr_info.get("dateIso", ""),
                    "place": marr_info.get("place", ""),
                    "notes": marr_info.get("notes", ""),
                },
                "divorce": {
                    "date": div_info.get("date", ""),
                    "dateDisplay": div_info.get("dateDisplay", ""),
                    "year": div_info.get("year"),
                    "dateIso": div_info.get("dateIso", ""),
                    "place": div_info.get("place", ""),
                },
                "events": fam_events,
                "notes": fam_notes,
                "rin": root.get_text("RIN"),
                "uid": root.get_text("_UID"),
            }

    # Pick default person
    if "@I28@" in individuals:
        meta["defaultPersonId"] = "@I28@"
    elif "@I1@" in individuals:
        meta["defaultPersonId"] = "@I1@"
    elif individuals:
        meta["defaultPersonId"] = next(iter(individuals.keys()))

    return {
        "meta": meta,
        "individuals": individuals,
        "families": families,
        "sources": sources,
    }


def sync_media_files(tree: Dict[str, Any], media_dir: str) -> Dict[str, int]:
    """Download remote media URLs in the tree to local media_dir and update URLs to /media/<filename>."""
    os.makedirs(media_dir, exist_ok=True)
    downloaded = 0
    cached = 0
    failed = 0

    for person_id, person in tree.get("individuals", {}).items():
        media_list = person.get("media", [])
        for m in media_list:
            local_fname = m.get("localFilename")
            orig_url = m.get("originalUrl") or m.get("url", "")
            if not local_fname:
                continue
            local_path = os.path.join(media_dir, local_fname)
            if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
                m["url"] = f"/media/{local_fname}"
                cached += 1
            elif orig_url.startswith("http://") or orig_url.startswith("https://"):
                try:
                    req = urllib.request.Request(
                        orig_url,
                        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
                    )
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        data = resp.read()
                        if data:
                            with open(local_path, "wb") as f:
                                f.write(data)
                            m["url"] = f"/media/{local_fname}"
                            downloaded += 1
                except Exception as e:
                    print(f"[MediaSync] Failed to download {orig_url}: {e}")
                    failed += 1

        # Refresh primaryPhoto pointer to local /media/... if available
        prim = None
        for m in media_list:
            if m.get("isPrimary") and m.get("form") != "pdf":
                prim = m["url"]
                break
        if not prim:
            for m in media_list:
                if m.get("form") in ("jpg", "jpeg", "png", "webp"):
                    prim = m["url"]
                    break
        person["primaryPhoto"] = prim

    return {"downloaded": downloaded, "cached": cached, "failed": failed}


def _write_multiline_tag(lines: List[str], level: int, tag: str, text: str):
    if not text:
        return
    paragraphs = text.replace("\r\n", "\n").split("\n")
    for idx, p in enumerate(paragraphs):
        cur_tag = tag if idx == 0 else "CONT"
        # Escape @ as @@ per GEDCOM 5.5.1 if needed
        if len(p) <= 240:
            lines.append(f"{level} {cur_tag} {p}")
        else:
            chunks = [p[i:i+240] for i in range(0, len(p), 240)]
            lines.append(f"{level} {cur_tag} {chunks[0]}")
            for ch in chunks[1:]:
                lines.append(f"{level + 1} CONC {ch}")


def export_tree_to_gedcom(tree: Dict[str, Any]) -> str:
    """Serialize the internal tree JSON back into a valid GEDCOM 5.5.1 string."""
    lines: List[str] = []
    now_str = datetime.utcnow().strftime("%d %b %Y").upper()

    meta = tree.get("meta", {})
    lines.append("0 HEAD")
    lines.append("1 GEDC")
    lines.append("2 VERS 5.5.1")
    lines.append("2 FORM LINEAGE-LINKED")
    lines.append("1 CHAR UTF-8")
    lines.append("1 LANG Italian")
    lines.append("1 SOUR RADICA")
    lines.append(f"2 NAME Ràdica - {meta.get('title', 'Albero Genealogico')}")
    lines.append("2 VERS 1.0")
    lines.append(f"1 DATE {now_str}")

    # Individuals
    for pid, p in tree.get("individuals", {}).items():
        lines.append(f"0 {pid} INDI")
        givn = p.get("givenName", "").strip()
        surn = p.get("surname", "").strip()
        npfx = p.get("prefix", "").strip()
        nsfx = p.get("suffix", "").strip()
        marnm = p.get("marriedSurname", "").strip()

        ged_name = f"{givn} /{surn}/"
        if nsfx:
            ged_name += f" {nsfx}"
        lines.append(f"1 NAME {ged_name.strip()}")
        if npfx:
            lines.append(f"2 NPFX {npfx}")
        if givn:
            lines.append(f"2 GIVN {givn}")
        if surn:
            lines.append(f"2 SURN {surn}")
        if nsfx:
            lines.append(f"2 NSFX {nsfx}")
        if marnm:
            lines.append(f"2 _MARNM {marnm}")

        sex = p.get("sex", "U")
        lines.append(f"1 SEX {sex}")

        # Birth
        birth = p.get("birth", {})
        if birth.get("date") or birth.get("place"):
            lines.append("1 BIRT")
            if birth.get("date"):
                lines.append(f"2 DATE {normalize_input_date_to_gedcom(birth['date'])}")
            if birth.get("place"):
                lines.append(f"2 PLAC {birth['place']}")

        # Christening
        chr_data = p.get("christening", {})
        if chr_data.get("date") or chr_data.get("place"):
            lines.append("1 CHR")
            if chr_data.get("date"):
                lines.append(f"2 DATE {normalize_input_date_to_gedcom(chr_data['date'])}")
            if chr_data.get("place"):
                lines.append(f"2 PLAC {chr_data['place']}")

        # Death
        death = p.get("death", {})
        if p.get("isDeceased") or death.get("date") or death.get("place") or death.get("cause"):
            lines.append("1 DEAT Y")
            if death.get("date"):
                lines.append(f"2 DATE {normalize_input_date_to_gedcom(death['date'])}")
            if death.get("place"):
                lines.append(f"2 PLAC {death['place']}")
            if death.get("age"):
                lines.append(f"2 AGE {death['age']}")
            if death.get("cause"):
                lines.append(f"2 CAUS {death['cause']}")

        # Burial
        burial = p.get("burial", {})
        if burial.get("date") or burial.get("place"):
            lines.append("1 BURI")
            if burial.get("date"):
                lines.append(f"2 DATE {normalize_input_date_to_gedcom(burial['date'])}")
            if burial.get("place"):
                lines.append(f"2 PLAC {burial['place']}")

        # Occupation
        if p.get("occupation"):
            lines.append(f"1 OCCU {p['occupation']}")

        # Residence / Email / Address
        if p.get("address") or p.get("email"):
            lines.append("1 RESI")
            if p.get("address"):
                lines.append(f"2 ADDR {p['address']}")
            if p.get("email"):
                lines.append(f"2 EMAIL {p['email'].replace('@', '@@')}")

        # Additional custom events (excluding primary BIRT/DEAT/BURI/CHR already written)
        for ev in p.get("events", []):
            tag = ev.get("tag", "EVEN")
            if tag in ("BIRT", "DEAT", "BURI", "CHR", "BAPM", "OCCU", "RESI"):
                continue
            val = f" {ev['value']}" if ev.get("value") else ""
            lines.append(f"1 {tag}{val}")
            if ev.get("type") or (tag == "EVEN" and ev.get("label")):
                lines.append(f"2 TYPE {ev.get('type') or ev.get('label')}")
            if ev.get("date"):
                lines.append(f"2 DATE {normalize_input_date_to_gedcom(ev['date'])}")
            if ev.get("place"):
                lines.append(f"2 PLAC {ev['place']}")
            if ev.get("notes"):
                _write_multiline_tag(lines, 2, "NOTE", ev["notes"])

        # Notes
        if p.get("notes"):
            _write_multiline_tag(lines, 1, "NOTE", p["notes"])

        # Family links
        for fams_id in p.get("fams", []):
            lines.append(f"1 FAMS {fams_id}")
        for famc_id in p.get("famc", []):
            lines.append(f"1 FAMC {famc_id}")

        # Media
        for m in p.get("media", []):
            lines.append("1 OBJE")
            lines.append(f"2 FORM {m.get('form', 'jpg')}")
            file_ref = m.get("originalUrl") or m.get("url", "")
            lines.append(f"2 FILE {file_ref}")
            if m.get("title"):
                lines.append(f"2 TITL {m['title']}")
            if m.get("isPrimary"):
                lines.append("2 _PRIM Y")
            if m.get("isPersonalPhoto"):
                lines.append("2 _PERSONALPHOTO Y")
            if m.get("isCutout"):
                lines.append("2 _CUTOUT Y")
            if m.get("isParentPhoto"):
                lines.append("2 _PARENTPHOTO Y")
            if m.get("position"):
                lines.append(f"2 _POSITION {m['position']}")

        if p.get("rin"):
            lines.append(f"1 RIN {p['rin']}")
        if p.get("uid"):
            lines.append(f"1 _UID {p['uid']}")

    # Families
    for fid, fam in tree.get("families", {}).items():
        lines.append(f"0 {fid} FAM")
        if fam.get("husband"):
            lines.append(f"1 HUSB {fam['husband']}")
        if fam.get("wife"):
            lines.append(f"1 WIFE {fam['wife']}")
        for ch_id in fam.get("children", []):
            lines.append(f"1 CHIL {ch_id}")

        marr = fam.get("marriage", {})
        if marr.get("date") or marr.get("place") or marr.get("notes"):
            lines.append("1 MARR")
            if marr.get("date"):
                lines.append(f"2 DATE {normalize_input_date_to_gedcom(marr['date'])}")
            if marr.get("place"):
                lines.append(f"2 PLAC {marr['place']}")
            if marr.get("notes"):
                _write_multiline_tag(lines, 2, "NOTE", marr["notes"])

        div = fam.get("divorce", {})
        if fam.get("isDivorced") or div.get("date") or div.get("place"):
            lines.append("1 DIV Y")
            if div.get("date"):
                lines.append(f"2 DATE {normalize_input_date_to_gedcom(div['date'])}")
            if div.get("place"):
                lines.append(f"2 PLAC {div['place']}")

        if fam.get("notes"):
            _write_multiline_tag(lines, 1, "NOTE", fam["notes"])
        if fam.get("rin"):
            lines.append(f"1 RIN {fam['rin']}")
        if fam.get("uid"):
            lines.append(f"1 _UID {fam['uid']}")

    # Sources
    for sid, src in tree.get("sources", {}).items():
        lines.append(f"0 {sid} SOUR")
        if src.get("title"):
            lines.append(f"1 TITL {src['title']}")
        if src.get("author"):
            lines.append(f"1 AUTH {src['author']}")
        if src.get("publisher"):
            lines.append(f"1 PUBL {src['publisher']}")
        if src.get("text"):
            _write_multiline_tag(lines, 1, "TEXT", src["text"])
        if src.get("rin"):
            lines.append(f"1 RIN {src['rin']}")

    lines.append("0 TRLR")
    return "\r\n".join(lines) + "\r\n"
