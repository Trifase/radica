# 🌿 Ràdica — Self-Hosted Family Tree Viewer & GEDCOM Editor

**Ràdica** è un'applicazione web self-hosted leggera e veloce per esplorare, modificare e gestire alberi genealogici in formato **GEDCOM 5.5.1** (compatibile con MyHeritage, Ancestry, Gramps, ecc.).

## ✨ Caratteristiche Principali

- **4 Modalità di Visualizzazione Interattive** (con Pan/Zoom fluido e Minimappa):
  - 🎯 **Vista Persona (Clessidra):** concentrata su un individuo scelto, con antenati sopra (2–7 generazioni), coniugi e fratelli al centro, e discendenti sotto.
  - 🪭 **Ventaglio degli Antenati (Fan Chart):** grafico ad anelli concentrici (da 3 a 7 generazioni, apertura `180°`, `220°` o `360°`) colorato per ramo familiare.
  - 🌳 **Vista Completa:** l'intero albero genealogico disposto su livelli generazionali con ordinamento baricentrico e filtro rapido per cognome.
  - 📋 **Vista Elenco / Tabella:** elenco anagrafico completo ricercabile, filtrabile (sesso, viventi/deceduti, con/senza foto) e ordinabile.
- 🔗 **Calcolatore del Grado di Parentela & Linea Luminosa:**
  - Calcola il legame tra due persone qualsiasi (sia di sangue tramite l'Antenato Comune più vicino *MRCA*, sia acquisito tramite matrimonio).
  - Evidenzia sull'albero con una **linea luminosa animata** tutti i passaggi che legano la Persona A alla Persona B.
- 📝 **Editor Completo & Media Locali:**
  - Modifica dati anagrafici, date, luoghi, occupazione, contatti, biografia/note ed eventi della vita.
  - Aggiunta, collegamento e rimozione di genitori, coniugi, figli e fratelli.
  - Caricamento di foto profilo e documenti PDF salvati localmente (più download automatico in locale delle foto remote presenti nei file GEDCOM).
- 📥/📤 **Importazione ed Esportazione GEDCOM 5.5.1 (`.ged`):**
  - Importa qualsiasi file `.ged` con backup automatico e riesporta l'albero aggiornato in standard GEDCOM 5.5.1 UTF-8.

## 🚀 Avvio Rapido con Docker Compose

```bash
git clone https://github.com/Trifase/radica.git
cd radica
docker compose up -d --build
```

L'applicazione sarà disponibile su `http://localhost:4000`. Tutti i dati e i file multimediali vengono salvati nella cartella `./data` (ignorata da Git).
