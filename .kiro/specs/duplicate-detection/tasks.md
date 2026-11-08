# Implementation Plan: Duplicate Detection

## Overview

Der Plan setzt das Design inkrementell auf der bestehenden Platform (`real-estate-platform`, `listing-management`) um. Reihenfolge: reine Logik in `shared` (Objektmerkmale, Taxonomie-Bindung, Normalisierung, Merkmalsprofil, Bewertung, Blockschlüssel, Markierungstypen), dann `core` (Inhaltsvorbereitung, Konfiguration, Stores, `DuplicateDetector`, Writer, Befehle), Import-Pipeline, Abgleich und agenturübergreifende Treffer, Löschprozess, Management_API, Infrastruktur, Frontend, Kalibrierung und zuletzt Developer_Documentation und Integrationstests.

Sprache: **TypeScript (strict)** in allen Paketen, Schemas mit **Zod v4** in `@open-estate/shared`, Tests mit **Jest + fast-check**. Jede der 24 Correctness Properties ist genau ein optionaler PBT-Sub-Task (`*`) direkt bei der implementierenden Logik; jeder Property-Test läuft mit `fc.assert(..., { numRuns: 100 })` und trägt den Tag-Kommentar `Feature: duplicate-detection, Property N: ...`. Domänendienste werden gegen In-Memory-Fakes mit Transaktionssemantik getestet (gleiche Interfaces wie die DynamoDB-Implementierungen).

Festgelegte Entscheidungen: Ein bei der Anlage erkanntes Duplikat wird mit `INACTIVE` und Duplikat_Markierung gespeichert; Änderungen, Import-Updates und der Abgleich setzen nur Markierungen und ändern nie den Status. Prüfbereich ist die Agentur (Listings ohne Agentur bilden einen gemeinsamen Bereich); agenturübergreifende Treffer entstehen nur im täglichen Abgleich und sind nur für Plattform_Admins sichtbar. Original ist der älteste Treffer nach Anlagezeitpunkt. Markierungen sind Verwaltungsdaten ohne Version. Nicht zulässige Objektmerkmale werden verworfen und benannt. Keine Bestandsinstallation, keine Migration.

## Tasks

- [x] 1. `shared`: Objektmerkmale und Taxonomie-Bindung
  - [x] 1.1 Objektmerkmale im Listing-Schema ergänzen
    - `LISTING_BOUNDS` um `houseNumber`, `unit`, `floor`, `totalFloors`, `yearBuilt`, `plotArea`, `bedrooms`, `bathrooms`, `parcelId`; `Address` um `houseNumber?`, `unit?`; `PlotArea` als Dezimal-Schema; `ListingBase` um die übrigen Merkmale (alle optional)
    - `refineListing`: Regel `floor ≤ totalFloors` mit Issue auf `floor`, läuft auch nach Feldfehlern
    - `CONTENT_FIELDS` erweitern; `serialize` liefert vorhandene Merkmale (`plotArea` als Dezimal-String), fehlende werden weggelassen
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.8_

  - [x]* 1.2 Property-Test für die Validierung der Objektmerkmale schreiben
    - **Property 1: Validierung der Objektmerkmale**
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [x]* 1.3 Property-Test für den abwärtskompatiblen Inhalts_Hash schreiben
    - **Property 2: Abwärtskompatibler Inhalts_Hash**
    - **Validates: Requirements 1.4, 1.9**

  - [x] 1.4 Taxonomie-Bindung in `taxonomy.ts` implementieren
    - `BINDABLE_ATTRIBUTES`; `attributes?` in `NestedTaxonomyConfig` und `FlatTaxonomyConfig`; `Taxonomy.groups[].attributes` (ohne Angabe alle)
    - `validateTaxonomy`: Verstöße `UNKNOWN_ATTRIBUTE` und `DUPLICATE_ATTRIBUTE` je Gruppe und Code; `allowedAttributes(taxonomy, listingType)`
    - Standard-Taxonomie `config/taxonomy.json` um die Bindungen aus Req 2.3 ergänzen
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x]* 1.5 Unit-Tests für die Standard-Taxonomie schreiben
    - Bindungen je Gruppe laut Req 2.3; Konfiguration ohne `attributes` lässt alle zu; Fehlermeldung nennt Gruppe, Code und Verstoß
    - _Requirements: 2.2, 2.3, 2.4_

  - [x] 1.6 Test-Generatoren für Objektmerkmale und Taxonomien erweitern
    - Listing_Inhalte mit beliebigen Teilmengen gültiger und ungültiger Merkmale, Taxonomien mit zufälligen Merkmalslisten (inkl. unbekannter und doppelter Codes)
    - _Requirements: 1.1, 2.1_

- [x] 2. `shared`: Duplikat_Bewertung als reine Logik
  - [x] 2.1 Schema und Standardwerte der Duplikat_Konfiguration anlegen
    - `duplicates/config.ts`: `DuplicateConfig` (Schwellenwert, `maxCandidates`, `textNearHamming` 0–7, `geoNearMeters`, Toleranzen mit Ordnungsregeln, Gewichte je Grund, Normalisierungs-Aliase, `sweep.timeUtc`, `sweep.segments`)
    - `config/duplicate-detection.json` mit den Standardwerten aus dem Design; Export eines Hashes der profilrelevanten Regeln (`rules`)
    - _Requirements: 3.8, 3.9_

  - [x] 2.2 Normalisierung in `duplicates/normalize.ts` implementieren
    - `normalizeText`, `normalizeStreet` (Straßenzusätze aus der Konfiguration), `splitHouseNumber` (führend/abschließend, Zusätze und Bereiche), `normalizePostalCode`, Normalisierung der Einheit mit Füllwörtern
    - _Requirements: 1.8, 3.2_

  - [x]* 2.3 Property-Test für die Normalisierungsinvarianz schreiben
    - **Property 5: Normalisierungsinvarianz**
    - **Validates: Requirements 1.8, 3.2**

  - [x] 2.4 SimHash und Merkmalsprofil implementieren
    - `duplicates/simhash.ts` (64 Bit über Wort-Bigramme, `hamming`); `duplicates/profile.ts`: `buildProfile` (Originalsprache, Medien als sortierte Hashmenge, abgeleitete Quell-URL ausgelassen, SHA-256 mit Domänenpräfix für Adresse, Einheit, Flurstück, URLs, `exactKey`); keine Personenbezogenen_Felder
    - _Requirements: 3.1, 3.6, 12.1_

  - [x] 2.5 `scoreMatch` und Katalog der Übereinstimmungsgründe implementieren
    - `duplicates/reasons.ts` (stabile Codes, Katalogreihenfolge); `duplicates/score.ts`: Ausschluss, Exakt, Ortsanker, gewichtete Summe in [0, 1], Schwellenwert
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.10_

  - [x]* 2.6 Property-Test für die Eigenschaften der Bewertung schreiben
    - **Property 6: Eigenschaften der Bewertung**
    - **Validates: Requirements 3.1, 3.7, 3.10**

  - [x]* 2.7 Property-Test für Ausschluss, Anker und Schwellenwert schreiben
    - **Property 7: Ausschluss, Anker und Schwellenwert**
    - **Validates: Requirements 3.3, 3.4, 3.5**

  - [x]* 2.8 Property-Test für Exakt_Duplikate schreiben
    - **Property 8: Exakt_Duplikat**
    - **Validates: Requirements 3.6**

  - [x] 2.9 Blockschlüssel in `duplicates/blocks.ts` implementieren
    - `blockKeys` (`A`, `G`, `P`, `U`, `T` mit h+1 Bändern), `lookupKeys` (Geo-Nachbarring mit berechnetem k, Datumsgrenze, Begrenzung ab 85°), Priorität der Schlüsselarten für die Kandidatenobergrenze
    - _Requirements: 3.4, 4.2, 5.7_

  - [x] 2.10 Markierungs- und Management-Typen ergänzen
    - `flags.ts`: `DuplicateFlag`, `ListingFlag` (Union über `code`), `StatusReason`, Zod-Schemas, `duplicateFlag(listing, matches, detectedBy, at)` (Original = ältester älterer Treffer, höchstens fünf Treffer absteigend), `withDuplicateFlag`, `flagCodes`, `isOlder`
    - Fehlercode `IDEMPOTENCY_KEY_REUSED` (409); Berechtigung `duplicate:review` nur für `PLATFORM_ADMIN`, nicht gewährbar, Berechtigungsmatrix neu erzeugt
    - Die Antwort-Schemas (`ListingView`, `ListingSummary`, `VersionEntry`, `ListListingsQuery`) und `ActorRef` werden mit ihren Erzeugern in Task 3.4 und 4.9 erweitert
    - _Requirements: 7.1, 7.2, 7.8, 11.4, 14.3_

  - [x] 2.11 Test-Generatoren für Duplikat-Paare und Bestände erweitern
    - Kopien mit Umformungen aus Req 3.2, Paare mit genau einem abweichenden Signal oder einem Ausschlusskriterium, Geo-Paare in beliebiger Breite und über die Datumsgrenze, Text-Paare mit vorgegebenem Hamming-Abstand, Bestände mehrerer Prüfbereiche mit Verwerfungen und Anlagezeitpunkten
    - _Requirements: 3.2, 3.3, 3.4, 4.1_

- [x] 3. `core`: Inhaltsvorbereitung, Konfiguration, Stores und Detector
  - [x] 3.1 Merkmalsbindung in `prepareContent` ergänzen
    - Schritt nach dem PII-Filter: nicht zulässige Bindbare_Objektmerkmale entfernen, `attributeDrops` zurückgeben; `droppedFieldNames` im `ListingCommandService` nennt sie; Wiederherstellung nutzt denselben Schritt
    - _Requirements: 2.5_

  - [x]* 3.2 Property-Test für die Taxonomie-Bindung schreiben
    - **Property 4: Taxonomie-Bindung**
    - **Validates: Requirements 2.1, 2.2, 2.4, 2.5**

  - [x] 3.3 Duplikat_Konfiguration laden
    - Optionale Datei `duplicate-detection.json` über den bestehenden Konfigurationsweg (wie `tour-providers.json`), Init-Abbruch mit allen Feldfehlern, Neuladen über `open-estate-admin reload`
    - _Requirements: 3.8, 3.9_

  - [x] 3.4 Verwaltungsdaten und Listing-Store erweitern
    - `ListingManagement` um `createdAt`, `flags`, `flagCodes` (Schema, `toManagedListingItem`, Disjunktheitsprüfung); Filter `flag` im In-Memory- und DynamoDB-Store (`contains(flagCodes, :flag)`); `ListingVersionRecord.statusReason`; Anlagezeitpunkt-Fallback `lastImportedAt` für Listings ohne `createdAt`
    - _Requirements: 5.4, 7.1, 7.3, 7.5_

  - [x] 3.5 `DuplicateIndexStore` implementieren
    - Interface, In-Memory-Fake mit Transaktionssemantik und simulierbarer GSI-Verzögerung, DynamoDB-Implementierung (`getProfile`, `getProfiles`, `candidates` über `byBlock` mit/ohne Prüfbereich, `exactOwner`, `syncOps`, `claimExactOp`, `releaseExactOp`, Labels `duplicateIndex.*`)
    - _Requirements: 4.1, 4.2, 12.1_

  - [x] 3.6 `IdempotencyStore` implementieren
    - Interface, In-Memory-Fake (simulierte Uhr), DynamoDB-Implementierung (`get` stark konsistent mit Ablaufprüfung, `putOp` mit `attribute_not_exists`, Label `idempotency.put`, Abfrage über `byListing` für die Löschung)
    - _Requirements: 9.2, 9.3, 9.4_

  - [x] 3.7 `DuplicateDetector` implementieren
    - `assess`: Profil, parallele Kandidatensuche (höchstens 16 gleichzeitig) im Prüfbereich, Obermenge mit Priorität und `truncated`, Profile laden, `exactOwner`, Verwerfungen in beide Richtungen, `scoreMatch`, Original nach `(createdAt, id)`; `DuplicateIndexUnavailable` bei Index-Fehlern und Deadline (`AbortSignal`)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.7, 5.8, 8.3_

  - [x]* 3.8 Property-Test für die verlustfreie Kandidatensuche schreiben
    - **Property 9: Verlustfreie Kandidatensuche**
    - **Validates: Requirements 3.4, 4.2, 5.1**

- [x] 4. `core`: Writer und Listing-Befehle
  - [x] 4.1 `VersionedListingWriter` erweitern
    - `StateChange` um `flags`, `statusReason`, `dismiss`, `duplicate`, `idempotency`; gespeichertes Profil lesen; `syncOps`, Exakt-Schlüssel beanspruchen/freigeben, Verwerfungen, Idempotenz-Eintrag und Zähler `listing.flags.DUPLICATE` im selben Transaktionsschreiben; `createdAt` bei Version 1
    - Abbruchgründe `EXACT_CLAIMED` (mit Eigentümer) und `IDEMPOTENCY_RACE`; neue Methode `setFlags` ohne Version mit Versionsbedingung
    - _Requirements: 5.2, 5.4, 6.1, 7.3, 8.1, 8.2, 9.1, 14.5_

  - [x]* 4.2 Property-Test für die Index-Konsistenz schreiben
    - **Property 10: Index-Konsistenz**
    - **Validates: Requirements 5.1, 6.1, 10.4**

  - [x]* 4.3 Property-Test für die Markierungszähler schreiben
    - **Property 22: Zähler der Markierungen**
    - **Validates: Requirements 14.5**

  - [x] 4.4 Duplikat_Prüfung in `ListingCommandService.create` einbauen
    - `assess` nach `prepareContent`; Duplikat ⇒ `INACTIVE`, Markierung `CREATE`, Statusbegründung; `claimExact` nur ohne Eigentümer; einmalige Wiederholung bei `EXACT_CLAIMED`; 503 bei `DuplicateIndexUnavailable`; Antwort 201 mit `status` und `flags`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.8, 9.1_

  - [x] 4.5 Duplikat_Prüfung bei Bearbeitung, Wiederherstellung und Agenturzuweisung einbauen
    - `assess` mit neuem Inhalt bzw. neuem Prüfbereich, `dismissed` aus dem Profil, Markierung `UPDATE` (bei unverändertem Ergebnis bleibt `updatedAt`), Status unverändert; Antwort mit aktuellen Markierungen
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 7.6_

  - [x] 4.6 Freigabe und Verwerfen implementieren
    - `setStatus`: `ACTIVE` auf markiertem Listing ⇒ `assess`, Markierung entfernen, Verwerfungen für alle aktuellen Treffer in der Status-Version; andere Statusänderungen lassen `flags` unverändert
    - `dismissFlag(principal, id, code)` mit `listing:status`: ohne Markierung Erfolg ohne Änderung, sonst `setFlags` mit Verwerfungen
    - _Requirements: 6.4, 8.1, 8.2, 8.3, 8.4, 8.6_

  - [x] 4.7 Idempotenzschlüssel in `create` einbauen
    - Vorprüfung (gleicher `requestHash` ⇒ Wiederholung mit aktueller Darstellung, sonst 409 `IDEMPOTENCY_KEY_REUSED`), `actorKey` je Benutzer bzw. Maschinenzugang, Eintrag im Writer-Transaktionsschreiben, Wiederholung bei `IDEMPOTENCY_RACE`; Ergebnis trägt die Kennzeichnung „Wiederholung“ für den Header
    - _Requirements: 9.2, 9.3, 9.4, 9.6_

  - [x] 4.8 Audit-Einträge für Markierungen schreiben
    - `listing.flag.set|update|remove|dismiss` und `listing.create.replay` mit Akteur, Ziel, Code, Original und Gründen ohne Inhaltswerte; System-Akteur des Abgleichs
    - _Requirements: 7.7, 12.2_

  - [x] 4.9 Antwort-Schemas und `ListingQueryService` erweitern
    - `ListingView` (`flags`, `createdAt`), `ListingSummary` (`flagCodes`), `VersionEntry` (`statusReason`), `ListListingsQuery` (`flag`); Schemas für Treffer-Liste und Abgleich-Start sowie `ActorRef` `system` kommen mit ihren Erzeugern in Task 7.1–7.3
    - `ListingQueryService` füllt sie; Filter `flag`; Bezeichner nur aus dem eigenen Prüfbereich
    - _Requirements: 5.4, 7.5, 7.6_

  - [x]* 4.10 Property-Test für die Markierung nach Schreibvorgängen schreiben
    - **Property 11: Markierung nach Schreibvorgängen**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 6.1, 6.3, 7.1, 7.2, 7.6**

  - [x]* 4.11 Property-Test für die Anlage eines Duplikats schreiben
    - **Property 12: Anlage eines Duplikats**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.6**

  - [x]* 4.12 Property-Test für nebenläufige Exakt_Duplikate schreiben
    - **Property 15: Nebenläufige Exakt_Duplikate**
    - **Validates: Requirements 9.1**

  - [x]* 4.13 Property-Test für Idempotenzschlüssel schreiben
    - **Property 16: Idempotenzschlüssel**
    - **Validates: Requirements 9.2, 9.3, 9.4, 9.5, 9.6**

  - [x]* 4.14 Property-Test für die öffentliche Projektion mit Objektmerkmalen schreiben
    - **Property 3: Öffentliche Projektion mit Objektmerkmalen**
    - **Validates: Requirements 1.5, 1.6, 7.4**

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. `ingestion`: Duplikat_Prüfung im Import
  - [x] 6.1 Schritt 5a in `ImportPipeline.process` einbauen
    - Neuanlage: `assess` im Prüfbereich des Connectors, Duplikat ⇒ `INACTIVE` statt gelieferter bzw. Standardstatus, Markierung `CREATE`, Statusbegründung; Update: Markierung `UPDATE`, Status unverändert; `EXACT_CLAIMED` über die bestehende Wiederholung; `DuplicateIndexUnavailable` ⇒ Abweisung „Duplikatprüfung nicht verfügbar“
    - _Requirements: 5.1, 5.2, 5.9, 6.1, 6.2_

  - [x] 6.2 Lauf-Zähler und Protokoll erweitern
    - `RunSummary`, `ConnectorRuns`, `persistent-run-logger` und Lauf-Ansicht der Management_API um `flagged`; `RunLogger.recordFlagged(listingId, originalId, reasons)` und verworfene Merkmale wertfrei
    - _Requirements: 2.5, 5.5_

  - [x]* 6.3 Property-Test für Import und Duplikate schreiben
    - **Property 23: Import und Duplikate**
    - **Validates: Requirements 5.1, 5.2, 5.5, 6.2**

- [x] 7. `core`: Duplikat_Abgleich und agenturübergreifende Treffer
  - [x] 7.1 `DuplicateReportStore` implementieren
    - Interface, In-Memory-Fake, DynamoDB-Implementierung: Upsert mit Zustandsregeln (`OPEN`/`DISMISSED`/`RESOLVED`), Liste über `byState` absteigend nach Wert mit Agenturfilter und Paginierung, Verwerfen, Auflösen nach `lastSweepId`; Verweise `R#{reportId}` im `DuplicateIndex`
    - _Requirements: 11.1, 11.3, 11.5, 11.6_

  - [x] 7.2 Phasen des Abgleichs als Dienst implementieren
    - `IndexPhase` (Profile neu berechnen, `syncOps` mit `ConditionCheck` auf die Listing-Version), `OrphanPhase` (verwaiste Einträge und verwaiste Verwerfungen entfernen), `MatchPhase` (Markierung je Profil über `setFlags` mit System-Akteur, Exakt-Eigentümer setzen, agenturübergreifende Paare mit `a < b`), `ResolvePhase`, `Finish` (Summen, Log-Zeile, EMF, Zähler `duplicate.cross_agency_open`); jede Phase segmentweise mit Cursor und Zeitbudget
    - _Requirements: 10.3, 10.4, 10.5, 10.6, 10.7, 11.1, 11.2, 11.6, 12.4_

  - [x] 7.3 Lambda-Handler und Starter des Abgleichs implementieren
    - `duplicate-sweep`-Handler (Phase, Segment, Cursor, Zeitbudget 10 min); `DuplicateSweepStarter` (`ListExecutions` RUNNING, sonst `StartExecution` mit Name `manual-{timestamp}`), Audit `duplicate-sweep.start`
    - _Requirements: 10.1, 10.2, 10.8_

  - [x]* 7.4 Property-Test für die Konvergenz des Abgleichs schreiben
    - **Property 17: Konvergenz des Abgleichs**
    - **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 12.4**

  - [x]* 7.5 Property-Test für agenturübergreifende Treffer schreiben
    - **Property 18: Agenturübergreifende Treffer**
    - **Validates: Requirements 4.5, 11.1, 11.2, 11.5, 11.6**

  - [x]* 7.6 Property-Test für Änderungen und Status schreiben
    - **Property 13: Änderungen und Status**
    - **Validates: Requirements 6.2, 6.4, 10.3, 11.2**

  - [x]* 7.7 Property-Test für Freigabe und Verwerfung schreiben
    - **Property 14: Freigabe und Verwerfung**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.6**

- [x] 8. `admin`: Löschprozess erweitern
  - [x] 8.1 `deleteListing` um Duplikat-Daten erweitern
    - Einträge unter `L#{id}` (Profil, Blöcke, Verweise) und eigenen Exakt-Schlüssel löschen, Treffer der Verweise löschen, `IdempotencyKeys` über `byListing` löschen; Vollständigkeitsprüfung erweitern; alle Schritte idempotent
    - _Requirements: 12.3_

  - [x]* 8.2 Property-Test für die Löschung der Duplikat-Daten schreiben
    - **Property 20: Löschung entfernt alle Duplikat-Daten**
    - **Validates: Requirements 12.3**

  - [x]* 8.3 Property-Test für „keine Klarwerte“ schreiben
    - **Property 21: Keine Klarwerte**
    - **Validates: Requirements 5.5, 7.7, 10.7, 12.1, 12.2**

- [x] 9. `management`: Routen, Kennzahlen und OpenAPI
  - [x] 9.1 Listing-Routen erweitern
    - Filter `flag` in `GET /listings`; `DELETE /listings/{id}/flags/{code}`; Header `Idempotency-Key` (Format, 400 mit `field: 'Idempotency-Key'`) an `create` durchreichen, Antwort-Header `Idempotent-Replayed: true` bei Wiederholung
    - _Requirements: 7.5, 8.2, 8.4, 9.2, 9.5_

  - [x] 9.2 Plattform-Routen ergänzen
    - `GET /platform/duplicate-reports`, `POST /platform/duplicate-reports/{reportId}/dismiss` (`duplicate:review`), `POST /platform/duplicate-sweeps` (`platform:operate`, 202)
    - _Requirements: 10.2, 11.3, 11.4, 11.5_

  - [x] 9.3 Kennzahlen im Kennzahlenkatalog ergänzen
    - `listing.duplicate_flags` (agency) und `duplicate.cross_agency_open` (platform) mit `resolve` über `MetricCounters`
    - _Requirements: 14.5_

  - [x] 9.4 OpenAPI-Dokument erweitern
    - Objektmerkmale, `flags`, `createdAt`, `statusReason`, Filter, Header, neue Operationen mit `x-required-permission`, Fehlercodes inkl. `IDEMPOTENCY_KEY_REUSED`
    - _Requirements: 1.6, 14.2, 14.3_

  - [x]* 9.5 Property-Test für die Isolation schreiben
    - **Property 19: Isolation**
    - **Validates: Requirements 7.6, 11.4**

  - [x]* 9.6 Unit-Tests für Routen und OpenAPI schreiben
    - Jede Portal-/Admin-Operation dieser Spec hat einen Endpunkt mit gleichen Fehlercodes; OpenAPI valide und vollständig
    - _Requirements: 14.1, 14.2_

- [x] 10. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. `infra`, Search_API und Dev-Server
  - [x] 11.1 Tabellen im `ManagementDataStack` anlegen
    - `DuplicateIndex` (GSI `byBlock`, KEYS_ONLY), `DuplicateReports` (GSI `byState`), `IdempotencyKeys` (GSI `byListing`, TTL `expiresAt`); On-Demand, PITR, Verschlüsselung wie die bestehenden Management-Tabellen
    - _Requirements: 9.2, 11.1, 12.3_

  - [x] 11.2 Konfigurationsdatei bereitstellen
    - `duplicate-detection.json` im Konfigurationsverzeichnis und Config-Bucket, Validierung zur Synthesezeit wie die Taxonomie
    - _Requirements: 3.8, 3.9_

  - [x] 11.3 Abgleich-Infrastruktur im `ManagementStack` anlegen
    - Lambda `duplicate-sweep`, State Machine `DuplicateSweep` (Map über Segmente, Schleife mit Cursor, Retry 3×, Timeout 4 h), EventBridge-Schedule `cron` aus `sweep.timeUtc`, Alarm auf `ExecutionsFailed`/`ExecutionsTimedOut`
    - _Requirements: 10.1, 10.8, 10.9_

  - [x] 11.4 Berechtigungen und Umgebungsvariablen verdrahten
    - management-Lambda (Index, Idempotenz, Treffer, `states:StartExecution`/`ListExecutions`), Connector-Lambdas (Index), Lösch-Lambda (alle drei Tabellen), Sweep-Lambda (Scan `Listings`, `UpdateItem` mit Bedingung, Index, Treffer, Zähler, `PutItem` auf `AuditLog`)
    - _Requirements: 5.1, 10.3, 12.3_

  - [x]* 11.5 CDK-Assertion-Tests schreiben
    - Tabellen, GSIs, TTL, PITR; Schedule; Timeout; Alarm; keine Lambda mit `UpdateItem`/`DeleteItem` auf `AuditLog`
    - _Requirements: 10.1, 10.8, 12.3_

  - [x] 11.6 `/meta` und API_Schema der Search_API erweitern
    - `taxonomy.groups[].attributes`; Objektmerkmale im Listing-Schema der Discovery; MCP-Ausgaben über `serialize`
    - _Requirements: 1.5, 1.6, 2.6_

  - [x] 11.7 Dev-Server verdrahten
    - In-Memory-Stores für Index, Treffer, Idempotenz; Abgleich im Prozess über `POST /platform/duplicate-sweeps`
    - _Requirements: 10.2_

- [x] 12. `frontend`: Agentur_Portal und Admin_Modus
  - [x] 12.1 Objektmerkmale im Listing-Formular
    - Abschnitt „Objektmerkmale“ aus `allowedAttributes` der Gruppe des gewählten Typs (`/meta`), Validierung mit dem `shared`-Schema, nicht mehr zulässige Werte beim Typwechsel nicht senden
    - _Requirements: 1.3, 2.7_

  - [x]* 12.2 Property-Test für Formular und Bindung schreiben
    - **Property 24: Portal-Formular und Bindung**
    - **Validates: Requirements 2.7**

  - [x] 12.3 Objektmerkmale in der Detailansicht anzeigen
    - Zeilen im Abschnitt „Objekt“ von `listing-detail-model.ts`, Übersetzungen `listing.attributes.*`
    - _Requirements: 1.7_

  - [x] 12.4 Markierungen in der Listing-Übersicht
    - Badge „Mögliches Duplikat“, Filter „Markierung“
    - _Requirements: 13.1_

  - [x] 12.5 Duplikat-Hinweis, Freigabe und Verwerfen im Arbeitsbereich
    - `DuplicateNoticeComponent` (Original als Link bzw. ohne Link, wenn nicht lesbar; Wert; übersetzte Gründe), „Trotzdem aktivieren“ mit Bestätigungsdialog, „Markierung verwerfen“, jeweils nach `can('listing:status')`; Hinweis nach einer Anlage mit Markierung
    - _Requirements: 8.5, 13.2, 13.3_

  - [x] 12.6 Statusbegründung in der Versionshistorie
    - Version mit `statusReason` als „automatisch deaktiviert (Duplikat von …)“
    - _Requirements: 13.4_

  - [x] 12.7 Admin-Ansicht „Duplikate“
    - Route `/portal/admin/duplicates`, `AdminDuplicatesComponent` mit Filtern Zustand/Agentur, Verweisen auf beide Listings, Verwerfen
    - _Requirements: 11.7_

  - [x] 12.8 Übersetzungen ergänzen
    - `portal.duplicates.*`, `listing.attributes.*`, `duplicate.reasons.*` in `de.json` und `en.json`
    - _Requirements: 13.5_

  - [x]* 12.9 Unit-Tests für Portal und Admin_Modus schreiben
    - Hinweis nach Anlage, Bestätigungsdialog, Bedienelemente nach Berechtigung, Zeitleiste, Admin-Ansicht
    - _Requirements: 8.5, 11.7, 13.1, 13.2, 13.3, 13.4_

- [x] 13. Seed-Daten, Kalibrierung und Lasttest
  - [x] 13.1 Seed-Daten erweitern
    - Objektmerkmale in den Beispiel-Listings, bewusst eingebaute Duplikate und Beinahe-Duplikate; das Seed-Skript und der Lasttest-Generator schreiben über die Import-Pipeline der Connectors (Version, Zähler, Duplikat_Prüfung)
    - _Requirements: 10.4_

  - [x] 13.2 Standardwerte kalibrieren
    - Katalog von Beispielpaaren „gleich“/„verschieden“ als Unit-Test (Neueinstellung mit neuem Text, baugleiche Wohnungen mit/ohne Einheit, benachbarte Hausnummern, andere PLZ); Gewichte und Schwellenwert bei Bedarf anpassen und in der Developer_Documentation nachziehen
    - _Requirements: 3.8_

  - [x] 13.3 Lasttest ergänzen
    - Zusätzliche Latenz der Anlage p95 ≤ 300 ms bei 200 Kandidaten; Durchsatz des Abgleichs je Segment als Nachweis für 1.000.000 Listings in 4 h
    - _Requirements: 5.7, 10.9_

- [x] 14. Developer_Documentation
  - [x] 14.1 `docs/management-api.md` erweitern
    - Abschnitt Duplikaterkennung (Regeln, Gründe-Katalog, Markierungen, Freigabe, Verwerfen, agenturübergreifende Treffer, Abgleich), Beispiel „Duplikat anlegen und freigeben“, Beispiel „Wiederholung mit `Idempotency-Key`“
    - _Requirements: 3.10, 14.4_

  - [x] 14.2 `docs/api.md` erweitern
    - Objektmerkmale im Listing-Datenmodell, Merkmale je Immobiliengruppe in `/meta`
    - _Requirements: 1.6, 2.6_

  - [x] 14.3 `docs/configuration.md` erweitern
    - `duplicate-detection.json` mit Standardwerten, Merkmalslisten in `taxonomy.json`, Hinweis, dass eine geänderte Uhrzeit des Abgleichs ein Deployment erfordert
    - _Requirements: 3.8, 14.4_

  - [x] 14.4 Berechtigungsmatrix neu erzeugen
    - `npm run docs:permissions` mit `duplicate:review`
    - _Requirements: 14.6_

  - [x] 14.5 CHANGELOG und Known Issues pflegen
    - Neue Funktionen, geänderte Anlage-Semantik (Req 4.2/12.5 `listing-management`), offene Punkte (Kalibrierung mit echten Daten, Kosten des Vollabgleichs, paralleles Seeding markiert erst im Abgleich)
    - _Requirements: 14.4_

- [x] 15. Integrationstests (DynamoDB Local)
  - `byBlock`-Abfragen mit Prüfbereichs-Präfix; Abbruchgründe `duplicateIndex.exactClaim` und `idempotency.put`; Lösch-Workflow entfernt alle Einträge der drei Tabellen; Abgleich über einen kleinen Bestand (Segmente, Cursor, Auflösen)
  - _Requirements: 9.1, 10.3, 10.4, 11.6, 12.3_
  - Umgesetzt in `packages/core/test/duplicates/duplicate-stores.integration.test.ts`; läuft nur mit `DYNAMODB_ENDPOINT` und wurde in der Entwicklungsumgebung mangels DynamoDB Local nicht ausgeführt

- [x] 16. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Ein- und Ausschalten der Duplikaterkennung
  - [x] 17.1 `core`: Erkennungsschalter
    - `SsmDuplicateDetectionSetting` (SSM `/open-estate/<env>/duplicate-detection`, 60-s-Cache, letzter Wert bei Lesefehler), `StaticDuplicateDetectionSetting`; `ListingCommandService` (Schalter je Befehl, Freigabe gegen die genannten Treffer), `VersionedListingWriter` (`duplicateDetection: 'disabled'` ohne Index-Operationen), `DuplicateReportService.getDetection/setDetection` (Audit, Abgleich beim Einschalten), Ablehnung des manuellen Starts
    - _Requirements: 15.1, 15.3, 15.5–15.10_
  - [x] 17.2 `ingestion`, `management`, Duplikat_Abgleich
    - Import-Pipeline und Connector-Lambda (`DUPLICATE_DETECTION_PARAMETER_NAME`), Routen `GET`/`PUT /platform/duplicate-detection` mit OpenAPI, Fehlercode `DUPLICATE_DETECTION_DISABLED`, `prepare` mit `enabled` und Choice `DetectionEnabled`
    - _Requirements: 15.3, 15.5, 15.6_
  - [x] 17.3 `infra`, Seed, Dev-Server
    - CDK-Kontextwert `duplicateDetection`, SSM-Parameter der DataStack, Variablen und Berechtigungen (Management_API lesen/schreiben, Connectors und Abgleich lesen); Seed-Skript und Lasttest-Generator folgen dem Parameter; `DEV_DUPLICATE_DETECTION`
    - _Requirements: 15.2, 15.9_
  - [x] 17.4 `frontend`: Schalter im Admin_Modus
    - Bereich „Betrieb“: Schalter mit Zustand, Bestätigung vor dem Ausschalten, Meldung zum gestarteten Abgleich; Hinweis und gesperrter manueller Start unter „Duplikate über Agenturen“; Texte de/en
    - _Requirements: 15.4_
  - [x] 17.5 Tests und Dokumentation
    - Unit-Tests je Paket (Schalter, Befehle ausgeschaltet, Wiedereinschalten mit Abgleich, Routen, Import, Stacks, Dev-Server, Frontend-Modell); Developer_Documentation (configuration, installation, management-api, local-demo, known-issues, CHANGELOG)
    - _Requirements: 15.1–15.10_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Jeder Task verweist auf konkrete Akzeptanzkriterien; alle 24 Correctness Properties sind genau einmal als PBT-Sub-Task abgebildet
- Bestehende Tests von `real-estate-platform` und `listing-management` laufen weiter; angepasst werden der Listing-Writer (Index, Markierungen), die Lauf-Zähler (`flagged`) und Tests, die Anlagen mit identischem Inhalt als unabhängige aktive Listings erwarten
- Keine Migration: es gibt keine bestehende Installation; Listings ohne `createdAt` (Seed) verwenden `lastImportedAt`
- Checkpoints sichern die inkrementelle Validierung
- Bei der Umsetzung gefunden und behoben: Der Anlagezeitpunkt eines neuen Listings muss der sein, mit dem die Duplikat_Prüfung entschieden hat (`StateChange.createdAt`), und nach einem verlorenen Wettlauf um den Exakt-Schlüssel liegt er nach dem des Gewinners; sonst konnten zwei gleichzeitig angelegte Exakt_Duplikate beide ohne Markierung bleiben (Property 15)
- Vorgezogen aus späteren Tasks, weil die Aufgaben sonst rot geblieben wären: die Registrierung von
  `duplicate-detection.json` in `infra/config-files.ts` (Teil von 11.2), der Eintrag des Fehlercodes
  in `docs/api.md` und die neu erzeugte Berechtigungsmatrix (Teil von 14.2/14.4) sowie die
  Objektmerkmal-Grenzen im dokumentierten `/meta`-Beispiel (Teil von 14.2)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.2", "2.10"] },
    { "id": 2, "tasks": ["1.5", "1.6", "2.3", "2.4", "3.3", "3.4"] },
    { "id": 3, "tasks": ["2.5", "3.1", "3.6"] },
    { "id": 4, "tasks": ["2.6", "2.7", "2.8", "2.9", "3.2"] },
    { "id": 5, "tasks": ["2.11", "3.5"] },
    { "id": 6, "tasks": ["3.7"] },
    { "id": 7, "tasks": ["3.8", "4.1"] },
    { "id": 8, "tasks": ["4.2", "4.3", "4.4", "4.9", "7.1"] },
    { "id": 9, "tasks": ["4.5", "4.6", "4.7", "4.14", "6.1"] },
    { "id": 10, "tasks": ["4.8", "4.10", "4.11", "4.12", "4.13", "6.2", "7.2"] },
    { "id": 11, "tasks": ["6.3", "7.3", "8.1", "9.1", "9.3"] },
    { "id": 12, "tasks": ["7.4", "7.5", "7.6", "7.7", "8.2", "9.2", "11.1"] },
    { "id": 13, "tasks": ["8.3", "9.4", "11.2", "11.6", "11.7"] },
    { "id": 14, "tasks": ["9.5", "9.6", "11.3", "12.1", "12.3", "12.4"] },
    { "id": 15, "tasks": ["11.4", "12.2", "12.5", "12.6", "12.7"] },
    { "id": 16, "tasks": ["11.5", "12.8", "13.1"] },
    { "id": 17, "tasks": ["12.9", "13.2", "14.1", "14.2", "14.3", "14.4"] },
    { "id": 18, "tasks": ["13.3", "14.5", "15"] },
    { "id": 19, "tasks": ["17.1"] },
    { "id": 20, "tasks": ["17.2", "17.3", "17.4"] },
    { "id": 21, "tasks": ["17.5"] }
  ]
}
```
