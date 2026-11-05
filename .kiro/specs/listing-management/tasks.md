# Implementation Plan: Listing Management

## Overview

Der Plan setzt das Design inkrementell auf der bestehenden Platform (`real-estate-platform`) um. Reihenfolge: reine Logik in `shared` (Berechtigungen, Inhaltsfelder und Hash, Diff, Zusammenführung, Sichtbarkeit, Provenienz), dann `core` (Identität, Berechtigung, Audit, versionierter Listing-Store, Befehle), öffentliche Sichtbarkeit, Import-Pipeline, Löschprozess, `AdminOperations`, Monitoring, das neue Paket `management`, Infrastruktur, Agentur_Portal/Admin_Modus und zuletzt Developer_Documentation und Integrationstests. Infrastruktur für Tabellen und Indizes wächst mit (Task 12.3 früh), die Stacks für Identität und Management_API folgen, sobald ihre Lambdas existieren.

Sprache: **TypeScript (strict)** in allen Paketen, Schemas mit **Zod v4** in `@open-estate/shared`, Tests mit **Jest + fast-check**. Jede der 33 Correctness Properties ist genau ein optionaler PBT-Sub-Task (`*`) direkt bei der implementierenden Logik; jeder Property-Test läuft mit `fc.assert(..., { numRuns: 100 })` und trägt den Tag-Kommentar `Feature: listing-management, Property N: ...`. Domänendienste werden gegen In-Memory-Fakes mit Transaktionssemantik getestet (gleiche Interfaces wie die DynamoDB/S3-Implementierungen).

Festgelegte Entscheidungen: Importmodus-Default `MERGE`, die mitgelieferten Module (`web-crawler`, `relational-db`, `external-api`) setzen `REPLACE` als Standard-Importmodus; `MERGE` führt Objekte rekursiv feldweise zusammen, ersetzt Listen als Ganzes, `null` entfernt optionale Felder auf jeder Ebene; Feldherkunft je Inhaltsfeld (Pfad bis Skalar oder Liste). `Listing`- und `LocalizedListing`-Schema bleiben unverändert; für `MANUAL` werden `sourceUrl`, `source`, `lastImportedAt` und `lastRunId` abgeleitet. Keine Bestandsinstallation, keine Migration.

## Tasks

- [ ] 1. `shared`: reine Logik der Listing-Verwaltung
  - [ ] 1.1 Verwaltungs-Typen, Fehlercodes und Management-Schemas anlegen
    - Typen `ListingStatus`, `Channel`, `ImportMode`, `ActorRef`, `FieldSource`, `FieldSources`, `VersionedState`, `ImportRecord` (tiefe Teilmenge mit `null`), `Principal`, `Permission`
    - Neue Fehlercodes im bestehenden Katalog (`AUTH_MISSING`, `AUTH_INVALID`, `MACHINE_ACCESS_EXPIRED`, `AGENCY_SUSPENDED`, `METRIC_NOT_ALLOWED`, `VERSION_CONFLICT`, `CUSTOM_ID_TAKEN`, `DELETION_BLOCKED`, `LAST_AGENCY_ADMIN`, `LAST_PLATFORM_ADMIN`, `USER_ALREADY_ASSIGNED`, `INVALID_PERMISSION`, `UNKNOWN_METRIC`)
    - Request-/Response-Schemas der Management_API, darunter `ManualContentInput` (Listing_Inhalt mit optionalem `sourceUrl`), Custom_Id 1–128 Zeichen; `canonicalJson` aus `cursor.ts` exportieren; `Listing` und `LocalizedListing` bleiben unverändert
    - _Requirements: 4.3, 4.5, 4.11, 6.1, 16.3_

  - [ ] 1.2 Berechtigungsmodell `permissions.ts` implementieren
    - Tabelle Rolle → Berechtigungen, `GRANTABLE_MACHINE_PERMISSIONS`, `authorize(principal, permission, resourceAgencyId)` mit der Regelreihenfolge des Designs (Plattform_Admin → ALLOW; fremde/agenturlose Ressource → `NOT_FOUND` bzw. plattformweit `FORBIDDEN`; fehlende Berechtigung → `FORBIDDEN`)
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 3.3, 3.4, 10.1, 10.2_

  - [ ]* 1.3 Property-Test für die Berechtigungsentscheidung schreiben
    - **Property 1: Berechtigungsentscheidung entspricht dem Referenzmodell**
    - **Validates: Requirements 2.2, 2.5, 2.6, 3.4, 10.1, 10.2**

  - [ ] 1.4 Inhaltsfelder und Inhalts_Hash in `content.ts` implementieren
    - `CONTENT_FIELDS`, `ListingContent`, `contentPaths` (Pfade bis Skalar oder Liste, Objekte rekursiv), `changedContentPaths` (hinzugefügt, entfernt, geändert), `contentHash` über `canonicalJson` der internen Darstellung ohne Provenienz- und Verwaltungsfelder
    - _Requirements: 4.7, 7.2, 7.3, 12.11_

  - [ ]* 1.5 Property-Test für den Inhalts_Hash schreiben
    - **Property 11: Inhalts_Hash**
    - **Validates: Requirements 4.7, 7.3**

  - [ ] 1.6 Diff in `diff.ts` implementieren
    - `diffState`/`applyDiff` über `VersionedState`: Objekte rekursiv mit sortierten Schlüsseln, Arrays positionsweise, deterministische Pfade, Einträge `add`/`remove`/`change` mit alten und neuen Werten
    - _Requirements: 5.5, 7.6, 7.7, 8.6_

  - [ ]* 1.7 Property-Test für den Diff-Round-Trip schreiben
    - **Property 16: Diff-Round-Trip**
    - **Validates: Requirements 7.6, 7.7**

  - [ ] 1.8 Zusammenführung und Importmodus in `merge.ts` implementieren
    - `mergeImport(existing, record, mode)`: `MERGE` rekursiv (Objekte feldweise, Listen und Skalare ersetzen, `null` entfernt auf jeder Ebene), `REPLACE` = gelieferter Inhalt (`null` wie fehlend), Neuanlage mit Schema-Defaults
    - `resolveImportMode(config, module) = config.importMode ?? module.defaultImportMode ?? 'MERGE'`
    - _Requirements: 12.6, 12.7, 12.8, 12.16_

  - [ ]* 1.9 Property-Test für die Zusammenführung beim Import schreiben
    - **Property 19: Zusammenführung beim Import**
    - **Validates: Requirements 12.6, 12.7, 12.8, 12.9**

  - [ ]* 1.10 Unit-Tests für `resolveImportMode` schreiben
    - Alle neun Kombinationen aus Konfiguration (`MERGE`/`REPLACE`/keine) und Modul-Standard (`MERGE`/`REPLACE`/keiner)
    - _Requirements: 12.16_

  - [ ] 1.11 Sichtbarkeit und Provenienz implementieren
    - `visibility.ts`: `isPublic(listing, suspendedAgencies)` (nur `ACTIVE` und Agentur nicht gesperrt)
    - `provenance.ts`: `publicDetailUrl(origin, id)` (`<origin>/listings/{encodeURIComponent(id)}`), `deriveProvenance` (`source` = Connector-Bezeichner bzw. `agency:{agencyId}`, `lastImportedAt` = Vorgangszeitpunkt, `lastRunId` = `runId` bzw. `{channel}#{version}`), Grenzen aus `LISTING_BOUNDS`
    - _Requirements: 1.8, 1.9, 4.5, 4.16, 4.17, 6.3, 6.4_

  - [ ] 1.12 Test-Generatoren in `shared/test/arbitraries` erweitern
    - Principals aller Rollen und Maschinenzugänge mit zufälligen Berechtigungsmengen, Agenturbestände, versionierte Listings (Status, Agentur, Custom_Id, Feldherkunft, Herkunft `IMPORT`/`MANUAL`), Import_Datensätze als tiefe Teilmengen mit `null` und Kennungskombinationen, Operationsfolgen, simulierte Uhr
    - _Requirements: 2.2, 7.1, 12.2, 12.6_

- [ ] 2. `core`: Identität, Agenturen, Maschinenzugänge und Audit
  - [ ] 2.1 Stores für Agenturen, Memberships, Zähler und Maschinenzugänge anlegen
    - Interfaces, In-Memory-Fakes mit Transaktionssemantik und DynamoDB-Implementierungen für `Agencies` (GSI `byState`), `Memberships` (GSI `byAgency`), `PlatformCounters`, `MachineAccess` (GSI `byAgency`)
    - _Requirements: 1.1, 1.2, 3.7_

  - [ ] 2.2 `Authenticator` implementieren
    - Cognito-Access-Token per `aws-jwt-verify` (Version gepinnt), Maschinengeheimnis `oem_<keyId>_<secret>` mit SHA-256 und `timingSafeEqual`, Ablauf/Widerruf, Agentursperre, TTL-Caches 60 s, `lastUsedAt` höchstens einmal pro Minute
    - _Requirements: 1.3, 1.6, 1.8, 2.4, 3.4, 3.5, 3.6_

  - [ ]* 2.3 Property-Test für das Authentifizierungsergebnis schreiben
    - **Property 4: Authentifizierungsergebnis**
    - **Validates: Requirements 1.6, 1.8, 2.4, 3.5, 3.6**

  - [ ] 2.4 `AgencyService` und `MembershipService` implementieren
    - Agentur anlegen/sperren/entsperren, Benutzer einladen (`AdminCreateUser`), Rollen ändern, entfernen, Plattform_Admins verwalten; Invarianten „letzter Agentur_Admin“/„letzter Plattform_Admin“ und „genau eine Zuordnung“ per `TransactWriteItems`; `dryRun`-Zählung betroffener Listings bzw. Benutzer
    - _Requirements: 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 10.8, 10.9_

  - [ ]* 2.5 Property-Test für die Admin-Invarianten schreiben
    - **Property 6: Admin-Invarianten**
    - **Validates: Requirements 1.2, 1.7, 10.9**

  - [ ] 2.6 `MachineAccessService` implementieren
    - Anlage mit 32 Byte Zufallsgeheimnis (einmalige Rückgabe, Speicherung nur als Hash), Prüfung `requested ⊆ GRANTABLE_MACHINE_PERMISSIONS` mit Nennung jeder unzulässigen Berechtigung, Widerruf, Darstellung ohne Geheimnis
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.7_

  - [ ]* 2.7 Property-Test für Maschinenzugänge schreiben
    - **Property 5: Maschinenzugänge – Berechtigungsprüfung und Geheimnis**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.7**

  - [ ] 2.8 `AuditService` implementieren
    - `append` mit Kategorien `management` und `access-denied`, Einträge mit Akteur, Kanal, Aktion, Ziel, Agentur, Ergebnis, Zeitpunkt; Abfrage paginiert absteigend mit Filtern (Akteur, Agentur, Aktion, Zeitraum) über GSI `byAgency` bzw. Kategorien; keine Update-/Delete-Operation im Interface
    - _Requirements: 2.8, 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ]* 2.9 Property-Test für die Audit-Abfrage schreiben
    - **Property 29: Audit-Abfrage**
    - **Validates: Requirements 11.1, 11.2, 11.4**

- [ ] 3. Checkpoint - Logik und Identität
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. `core`: versionierter Listing-Store und Befehle
  - [ ] 4.1 Stores für Versionen, Snapshots und Custom_Ids anlegen
    - `ListingVersions` (PK `listingId`, SK `version`, `changedPaths` mit vorheriger Feldherkunft und `overwrittenByImport`), `ListingKeys` (`agencyId#customId`), Snapshot-Store (S3 `listings/{id}/{contentHash}.json`, `If-None-Match: *`, 412 = vorhanden), `MetricCounters`; Fakes und AWS-Implementierungen; `Listings`-Item um `status`, `agencyId`, `origin`, `customId`, `version`, `contentHash`, `fieldSources`, `updatedAt` erweitern
    - _Requirements: 4.11, 6.1, 7.1, 7.2, 9.1_

  - [ ] 4.2 `VersionedListingWriter` implementieren
    - Unverändert-Erkennung (Hash, Status, Custom_Id, Agentur), `changedContentPaths`, Feldherkunft je Pfad, Kennzeichnung „durch Listenimport überschrieben“, Provenienzfelder per `deriveProvenance`, inhaltsadressierter Snapshot, ein `TransactWriteItems` (Listing mit Versionsbedingung, Version, Löschsperren-Checks, `ListingKeys`, Zähler `listing.status.*`, `history.*`, `listing.changes.*`), Abbildung von `CancellationReasons` auf `VERSION_CONFLICT`/`DELETION_BLOCKED`/`CUSTOM_ID_TAKEN`; Provenienz-Touch für unveränderte Importe
    - _Requirements: 4.7, 4.8, 4.9, 4.12, 4.16, 4.17, 6.9, 7.1, 7.2, 7.3, 7.4, 7.9, 12.11, 13.1, 14.5_

  - [ ]* 4.3 Property-Test „Keine Version ohne Änderung“ schreiben
    - **Property 10: Keine Version ohne Änderung**
    - **Validates: Requirements 4.7, 6.9, 7.1, 7.3**

  - [ ]* 4.4 Property-Test für die Versionshistorie schreiben
    - **Property 14: Versionshistorie ist lückenlos und unveränderlich**
    - **Validates: Requirements 7.1, 7.4, 7.5, 7.9, 9.1, 10.5**

  - [ ]* 4.5 Property-Test für die Feldherkunft schreiben
    - **Property 15: Feldherkunft**
    - **Validates: Requirements 7.2, 12.11, 12.15**

  - [ ]* 4.6 Property-Test für die Ableitung der Provenienzfelder schreiben
    - **Property 33: Ableitung der Provenienzfelder**
    - **Validates: Requirements 4.16, 4.17**

  - [ ]* 4.7 Property-Test für Bestands- und Historienzähler schreiben
    - **Property 25: Bestands- und Historienzähler entsprechen dem Bestand**
    - **Validates: Requirements 10.3, 13.1, 14.4, 14.5**

  - [ ] 4.8 `prepareContent` aus `ingestion` nach `core` verschieben
    - PII-Filter, Medien-/Tour-Bereinigung und Schema-Validierung als gemeinsame Funktion für Import und Management_API; Rückgabe der verworfenen Felder und aller Feldfehler; bestehende Import-Tests laufen unverändert
    - _Requirements: 4.3, 4.4, 4.10, 8.4_

  - [ ] 4.9 `ListingCommandService` implementieren
    - `create`, `replaceContent`, `setStatus`, `assignAgency`, `restore` nach dem Ablauf des Designs: Laden, `authorize`, `ManualContentInput` mit abgeleiteter Quell-URL (`publicDetailUrl`, Frontend-Origin als Konstruktorparameter), `prepareContent`, Bezugsversion, Kanalbestimmung (`PORTAL`/`API`/`ADMIN`), Schreiben über den Writer, Audit; `IMPORT`-Listings verlangen weiterhin `sourceUrl`; Wiederherstellung prüft gegen aktuelle Regeln und behält Status, Custom_Id und Agentur
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.8, 4.9, 4.11, 4.12, 6.2, 6.6, 8.1, 8.2, 8.4, 8.5, 10.2, 10.5, 10.6_

  - [ ]* 4.10 Property-Test für die manuelle Anlage schreiben
    - **Property 8: Manuelle Anlage**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.10**

  - [ ]* 4.11 Property-Test für optimistische Nebenläufigkeit schreiben
    - **Property 9: Optimistische Nebenläufigkeit**
    - **Validates: Requirements 4.6, 4.8, 8.5**

  - [ ]* 4.12 Property-Test für Custom_Id-Eindeutigkeit und Abruf schreiben
    - **Property 12: Custom_Id-Eindeutigkeit und Abruf**
    - **Validates: Requirements 4.11, 4.12, 4.13, 12.14**

  - [ ]* 4.13 Property-Test für Statusänderungen schreiben
    - **Property 13: Statusänderung erhält Inhalt und Historie**
    - **Validates: Requirements 6.2, 6.6**

  - [ ]* 4.14 Property-Test für die Wiederherstellung schreiben
    - **Property 17: Wiederherstellung**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

  - [ ] 4.15 `VersionService` und Listing-Abfragen implementieren
    - Versionshistorie paginiert absteigend, Version mit Snapshot, Diff zweier beliebiger Versionen aus Snapshots, Abruf über Bezeichner oder Custom_Id mit `sourceUrlDerived`, Listen über GSI `byAgency` mit Filtern (Status, Herkunft, Angebotsart, Listing_Typ, Custom_Id, Titel-Freitext) und Agenturfilter in der Key-Condition
    - _Requirements: 2.7, 4.13, 4.14, 7.5, 7.6, 10.4_

- [ ] 5. Öffentliche Sichtbarkeit
  - [ ] 5.1 Listing-Item, GSI und Indexer an den Listing_Status anpassen
    - `toListingItem` setzt `gsiPk` nur bei `ACTIVE`; Indexer behandelt `MODIFY` ohne `gsiPk` als `REMOVE`, überspringt unveränderte Suchdokumente; Suchdokument erhält `agencyId`
    - _Requirements: 4.15, 6.3, 6.5_

  - [ ] 5.2 Agentursperre und Detailabruf in Search_API und MCP_Server umsetzen
    - `SearchService` lädt gesperrte Agenturen (GSI `byState`, Cache 60 s) und ergänzt `excludeAgencies` für OpenSearch und DynamoDB; `ListingService.get` liefert für `!isPublic` denselben `NOT_FOUND` wie für unbekannte Bezeichner; MCP `get_listing` nutzt dieselbe Funktion
    - _Requirements: 1.8, 1.9, 6.4_

  - [ ]* 5.3 Property-Test für die öffentliche Sichtbarkeit schreiben
    - **Property 7: Öffentliche Sichtbarkeit**
    - **Validates: Requirements 1.8, 1.9, 6.3, 6.4, 6.5**

- [ ] 6. Import-Pipeline
  - [ ] 6.1 Connector-Konfiguration und Modul-Standard erweitern
    - `connectorConfigSchema` um `agencyId?` und `importMode?` erweitern; `ConnectorModule.defaultImportMode?`; `web-crawler`, `relational-db` und `external-api` setzen `defaultImportMode: 'REPLACE'`
    - _Requirements: 12.1, 12.16, 12.17_

  - [ ]* 6.2 Unit-Tests für die Standard-Importmodi der mitgelieferten Module schreiben
    - Jedes mitgelieferte Modul meldet `REPLACE`; ein an der Quelle entfallenes `geo` bzw. `address.street` fehlt nach dem nächsten Lauf; `importMode: 'MERGE'` in der Konfiguration überschreibt den Modul-Standard
    - _Requirements: 12.16, 12.17_

  - [ ] 6.3 Identitätsauflösung `resolveImportTarget` implementieren
    - Reine Funktion über ein Lese-Interface: „Identität fehlt“, „Identitätskonflikt“, Ziel über Bezeichner dann Custom_Id, Neuanlage mit gelieferter bzw. neuer Kennung, „Löschsperre“ für Bezeichner und `custom#{agency}#{customId}`, „Fremde Agentur“, Übernahme agenturloser Listings derselben Quelle
    - _Requirements: 12.2, 12.3, 12.4, 12.5, 12.12, 12.13, 12.14_

  - [ ]* 6.4 Property-Test für die Identitätsauflösung schreiben
    - **Property 18: Identitätsauflösung beim Import**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.12, 12.13, 12.14**

  - [ ] 6.5 `ImportPipeline.process` auf versioniertes Schreiben umstellen
    - Reihenfolge Mapping (inkl. `customId`, `status`) → Identität → PII/Medien auf gelieferte Felder → `mergeImport` mit `resolveImportMode` → PII auf Ergebnis → Validierung → Status (neu: geliefert bzw. `ACTIVE`, bestehend: gespeichert) → `VersionedListingWriter` (Kanal `IMPORT`, Akteur `{connectorId, runId}`), Provenienz-Touch bei `unchanged`, bis zu 3 Wiederholungen bei Versionskonflikt
    - _Requirements: 4.16, 6.7, 7.3, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11_

  - [ ]* 6.6 Property-Test für Import und Listing_Status schreiben
    - **Property 20: Import und Listing_Status**
    - **Validates: Requirements 6.7, 12.5, 12.10**

  - [ ] 6.7 Lauf-Zähler und persistierenden `RunLogger` implementieren
    - `RunSummary` um `unchanged`; Decorator schreibt Laufzusammenfassung nach `ConnectorRuns` (mit `agencyId`) und jede Abweisung (Bezeichner bzw. Custom_Id, Feldnamen, Grund, nie Werte) nach `RunRejections`, TTL 100 Tage
    - _Requirements: 13.2, 13.3_

  - [ ]* 6.8 Property-Test für die Lauf-Zähler schreiben
    - **Property 21: Lauf-Zähler**
    - **Validates: Requirements 13.2, 13.3**

  - [ ]* 6.9 Property-Test für die öffentliche Projektion schreiben
    - **Property 32: Öffentliche Projektion erfüllt das unveränderte API_Schema**
    - **Validates: Requirements 4.5, 4.18**

- [ ] 7. Checkpoint - Listing-Store, Sichtbarkeit und Import
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Löschprozess
  - [ ] 8.1 Lösch-Workflow um Versionen, Snapshots und Custom_Ids erweitern
    - Löschsperre für Bezeichner und Custom_Id in einer Transaktion, `Listings`/`ListingKeys` löschen, Zähler dekrementieren, `ListingVersions` per `Query` + `BatchWriteItem` und S3-Präfix per `ListObjectsV2` + `DeleteObjects` entfernen, Vollständigkeitsprüfung vor `EXECUTED`, sonst `OPEN` mit bestehender Überfälligkeitsbenachrichtigung (Message-Attribut `requesterId`)
    - _Requirements: 4.9, 6.8, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 8.2 Property-Test für die vollständige Löschung schreiben
    - **Property 22: Löschung entfernt Listing, Historie und Schlüssel vollständig**
    - **Validates: Requirements 4.9, 6.8, 9.2, 9.3, 9.5**

  - [ ]* 8.3 Property-Test für personenbezogene Werte in Audit, Kennzahlen und Lauf-Fehlern schreiben
    - **Property 23: Keine personenbezogenen Werte in Audit, Kennzahlen und Lauf-Fehlern**
    - **Validates: Requirements 9.4, 13.3, 13.4**

- [ ] 9. Admin-Use-Cases gemeinsam nutzbar machen
  - [ ] 9.1 `AdminOperations` aus `admin` nach `core` extrahieren
    - Löschanfragen, Löschsperre aufheben, API_Keys, Rate_Limit, Zugangsmodus, Reload als Use-Cases mit unveränderten Zod-Schemas, Fehlercodes und Audit-Einträgen; Akteur-Typ um `user` erweitern; Admin-Handler rufen die Use-Cases auf, Schnittstelle der Admin_API und bestehende Tests unverändert
    - _Requirements: 10.7_

- [ ] 10. Monitoring
  - [ ] 10.1 `MetricCatalog` und `MonitoringService` implementieren
    - `MetricDefinition` mit `resolve`, Katalog je Geltungsbereich, einheitliches `TimeSeries`-Format, `UNKNOWN_METRIC`/`METRIC_NOT_ALLOWED`, Deadline 10 s je Quelle mit `{code, available: false}`
    - _Requirements: 14.7, 15.1, 15.2, 15.3, 15.4_

  - [ ]* 10.2 Property-Test für die Kennzahlen-API schreiben
    - **Property 26: Kennzahlen-API**
    - **Validates: Requirements 15.2, 15.3, 15.4**

  - [ ]* 10.3 Property-Test für Teilergebnisse bei langsamen Quellen schreiben
    - **Property 27: Teilergebnisse bei langsamen Quellen**
    - **Validates: Requirements 14.7**

  - [ ] 10.4 Kennzahl-Resolver und fachliche Monitoring-Abfragen implementieren
    - `listing.count`, `listing.changes`, `listing.detail_views`, `listing.search_impressions`, `connector.runs` (aus `MetricCounters`/`ConnectorRuns`), `api.latency_p95`/`api.requests`/`api.responses` per `GetMetricData`, Alarme per `DescribeAlarms` mit Namenspräfix, `history.version_count`/`history.storage_bytes`; Übersicht, Connector_Läufe mit Fehlern, Agenturaktivität, Historienumfang
    - _Requirements: 13.1, 13.2, 13.3, 13.5, 14.1, 14.2, 14.3, 14.4, 14.5_

  - [ ] 10.5 Nutzungserfassung und `RequestCount` umsetzen
    - API- und MCP-Lambda schreiben je erfolgreicher Antwort die Usage-Logzeile (ohne IP, ohne Key) und emittieren `RequestCount` (EMF, `interface`, `endpoint`, `statusClass` inkl. `429`); `UsageAggregator`-Lambda zählt je `(listingId, Tag)` und `(agencyId, Tag)` und schreibt ein `ADD` je Schlüssel und Batch, TTL 100 Tage
    - _Requirements: 13.4, 13.5, 13.7, 14.1_

  - [ ]* 10.6 Property-Test für die Nutzungsaggregation schreiben
    - **Property 24: Nutzungsaggregation**
    - **Validates: Requirements 13.4, 13.5, 14.4**

- [ ] 11. Paket `management`: Management_API
  - [ ] 11.1 Lambda-Adapter, Router und Zugangsschutz anlegen
    - Paket `packages/management` mit Router, Request-Parsing per Zod, `ErrorResponse`-Abbildung, Deadline 4,5 s → `SERVICE_UNAVAILABLE`; `AccessGuard` mit IP-Limit vor und Akteur-Limit (`user:{id}`, `mk:{keyId}`) nach der Authentifizierung, SSM `/open-estate/{env}/management-rate-limit`; Audit `access-denied` bei 401/403; Frontend-Origin bei Init laden (Abbruch, wenn fehlend); Registrierung der Routengruppen über `routes/index.ts`
    - _Requirements: 2.4, 2.8, 2.9, 4.5, 16.3_

  - [ ]* 11.2 Property-Test für das Rate_Limit je Akteur schreiben
    - **Property 28: Rate_Limit je Akteur**
    - **Validates: Requirements 2.9**

  - [ ] 11.3 Routen für Identität und Agenturen implementieren
    - `/me`, `/agencies`, `/agencies/{id}`, Mitglieder, `/platform-admins`, Maschinenzugänge inkl. `?dryRun=true` für Sperren/Widerruf/Entzug
    - _Requirements: 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 3.1, 3.3, 3.5, 3.7, 5.6, 10.8, 10.9_

  - [ ] 11.4 Routen für Listings und Versionen implementieren
    - `/listings` (Liste, Anlage), `/listings/{id}`, `/listings/by-custom-id/{customId}`, Bearbeitung, `/status`, `/agency`, `/versions`, `/diff`, `/restore`; Plattform_Admins mit `agencyId`-Parameter
    - _Requirements: 4.1, 4.6, 4.13, 4.14, 6.2, 6.6, 7.5, 7.6, 8.1, 10.2, 10.4, 10.6_

  - [ ] 11.5 Routen für Audit, Monitoring und Kennzahlen implementieren
    - `/audit-log`, `/monitoring/*` (Agentur und Plattform), `/metrics`, `/metrics/{code}`
    - _Requirements: 11.4, 11.5, 13.1, 13.2, 13.3, 13.5, 14.1, 14.2, 14.3, 14.4, 14.5, 15.1, 15.2_

  - [ ] 11.6 Plattform-Routen auf `AdminOperations` implementieren
    - `/platform/deletions`, `/platform/deletion-blocklist/{listingId}`, `/platform/api-keys`, `/platform/rate-limit`, `/platform/access-mode`, `/platform/reload` mit `?dryRun=true` für Löschanfragen
    - _Requirements: 10.7, 10.8_

  - [ ]* 11.7 Property-Test für abgelehnte Operationen schreiben
    - **Property 2: Abgelehnte Operationen ändern nichts und werden auditiert**
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.8, 16.5**

  - [ ]* 11.8 Property-Test für die Agentur-Isolation von Listen schreiben
    - **Property 3: Agentur-Isolation von Listen**
    - **Validates: Requirements 2.7, 11.5, 15.1**

  - [ ] 11.9 OpenAPI-Dokument der Management_API generieren
    - Aus den Zod-Schemas und `permissions.ts`: je Operation `x-required-permission`, Parameter mit Wertebereichen, Antworten, Fehlercodes 401/403/404/409/429; öffentlicher Endpunkt `/openapi.json`
    - _Requirements: 16.1, 16.2_

  - [ ]* 11.10 Unit-Tests für OpenAPI, Paritäten und Abdeckung schreiben
    - OpenAPI ist valide und vollständig; `/platform/*` und `/admin/*` liefern für dieselben Eingaben dieselben Ergebnisse und Fehlercodes; jede Portal-Operation hat einen Endpunkt
    - _Requirements: 10.7, 16.1, 16.2_

- [ ] 12. Infrastruktur
  - [ ] 12.1 `IdentityStack` anlegen
    - Cognito User Pool ohne Selbstregistrierung, Managed Login, Domain, App-Client (Code + PKCE, Refresh-Token-Rotation); CDK-Trigger zum Anlegen des ersten Plattform_Admin aus `initialPlatformAdminEmail`, wenn `platformAdmins = 0`
    - _Requirements: 1.3, 5.1, 10.10_

  - [ ] 12.2 `ManagementStack` anlegen
    - REST API mit WAF, CORS mit `Authorization`, management-Lambda mit SSM `frontend-origin` und Abhängigkeit vom FrontendStack, `UsageAggregator` mit Subscription-Filter, Snapshot-Bucket (Block Public Access, SSE-KMS, ohne Versionierung), Tabellen `ListingVersions`, `ListingKeys`, `Agencies`, `Memberships`, `PlatformCounters`, `MachineAccess`, `MetricCounters`, `ConnectorRuns`, `RunRejections` mit TTL; IAM ohne `UpdateItem`/`DeleteItem` auf `AuditLog`, Reload-Recht nur auf API-, MCP- und Connector-Funktionen; CSP um Management- und Cognito-Origin erweitern
    - _Requirements: 2.9, 9.2, 10.7, 11.3, 13.4, 16.2_

  - [ ] 12.3 Bestehende Stacks erweitern
    - `Listings`: GSI `byId` sparse über `gsiPk`, neuer GSI `byAgency`; `AuditLog`: GSI `byAgency`; `DeletionBlocklist` für `custom#…`-Schlüssel; `RequestCount`-Berechtigungen und Umgebungswerte für API-, MCP- und Connector-Lambdas
    - _Requirements: 2.7, 6.3, 11.5, 14.1_

  - [ ]* 12.4 CDK-Assertions schreiben
    - WAF an der ManagementApi, Cognito ohne Selbstregistrierung, Bucket-Eigenschaften, keine Lambda-Rolle mit `UpdateItem`/`DeleteItem` auf `AuditLog`, TTLs, CSP-Origins, SSM-Parameter `frontend-origin` und Stack-Abhängigkeit
    - _Requirements: 9.2, 11.3, 13.4_

  - [ ]* 12.5 Unit-Tests für den Bootstrap des ersten Plattform_Admin schreiben
    - Legt Benutzer und Membership genau einmal an; bei vorhandenem Plattform_Admin keine Änderung
    - _Requirements: 10.10_

- [ ] 13. Checkpoint - Backend und Infrastruktur
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Frontend: Agentur_Portal und Admin_Modus
  - [ ] 14.1 Router und öffentliche Detail-Route anlegen
    - `@angular/router` mit `/` (bestehende Suche) und `/listings/:id` (bestehende Detailansicht, „nicht gefunden“ für unbekannte oder nicht öffentliche Listings)
    - _Requirements: 4.19_

  - [ ] 14.2 Anmeldung, Guards und `ManagementApiClient` anlegen
    - `angular-auth-oidc-client` (Version gepinnt, Code + PKCE, Tokens nur im Speicher/`sessionStorage`), lazy Route `portal` mit allen Unterrouten, `authGuard` mit Rückkehr zur angeforderten Route, `permissionGuard` und `can()` aus `/me`, Client mit Bearer-Interceptor, 10-s-Timeout und übersetzten Fehlermeldungen
    - _Requirements: 2.3, 5.1, 5.6, 5.7, 5.9_

  - [ ] 14.3 Listing-Übersicht und Listing-Formular implementieren
    - `ListingTableComponent` mit Filtern, Paginierung, Herkunft und Custom_Id; `ListingFormComponent` (reaktives Formular, Validierung über das `shared`-Schema, Quell-URL bei abgeleiteter URL leer, Eingaben bleiben bei Fehlern erhalten), 409-Konflikt mit `DiffViewComponent`
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.7, 5.9_

  - [ ] 14.4 Listing-Arbeitsbereich implementieren
    - `ListingWorkspaceComponent` mit Vorschau über `toPublicDetailModel`, `FieldProvenanceComponent` (Feldherkunft je Pfad, Hervorhebung „durch Listenimport überschrieben“), `VersionTimelineComponent` (Import-Versionen mit Connector und Lauf), Diff-Ansicht, Wiederherstellungsdialog mit Diff und Bestätigung
    - _Requirements: 5.8, 7.8, 8.6, 12.15_

  - [ ]* 14.5 Property-Test für Portal-Validierung und Bedienelemente schreiben
    - **Property 30: Portal-Validierung und Bedienelemente**
    - **Validates: Requirements 5.4, 5.6, 5.9**

  - [ ]* 14.6 Property-Test für die Vorschau schreiben
    - **Property 31: Vorschau entspricht der öffentlichen Detailansicht**
    - **Validates: Requirements 5.8**

  - [ ] 14.7 Monitoring-Ansicht der Agentur implementieren
    - `AgencyMonitoringComponent` mit Übersicht, Connector_Läufen (Fehler und Abweisungen), Nutzungszahlen; `MetricChartComponent` als generische SVG-Zeitreihe für Kennzahlen ohne eigene Ansicht
    - _Requirements: 13.6, 15.5_

  - [ ] 14.8 Team-, Maschinenzugangs- und Audit-Ansichten implementieren
    - Mitglieder einladen, Rollen ändern, entfernen; Maschinenzugänge anlegen (Geheimnis einmalig anzeigen), widerrufen, auflisten; Audit-Log der Agentur
    - _Requirements: 1.5, 1.6, 1.7, 3.1, 3.5, 3.7, 11.5_

  - [ ] 14.9 Admin_Modus implementieren
    - Agenturübersicht und -detail, agenturübergreifende Listing-Übersicht mit Agenturfilter, Plattform-Monitoring mit hervorgehobenen Alarmen und „nicht verfügbar“-Kennzeichnung, Betriebsfunktionen (`/platform/*`), Plattform-Audit; Bestätigungsdialoge mit `dryRun`-Anzahlen; Zugang nur für `PLATFORM_ADMIN`
    - _Requirements: 10.1, 10.3, 10.4, 10.7, 10.8, 14.6, 14.7_

  - [ ]* 14.10 Komponententests für das Portal schreiben
    - Zeitleisten-Kennzeichnung von Import-Versionen, Feldherkunft-Hervorhebung, Wiederherstellungs- und Bestätigungsdialoge, generische Zeitreihe, Alarm-Hervorhebung, Route `/listings/:id`
    - _Requirements: 4.19, 7.8, 8.6, 10.8, 12.15, 14.6, 15.5_

- [ ] 15. Developer_Documentation
  - [ ] 15.1 Berechtigungsmatrix und Maschinenzugangs-Beispiel generieren
    - Matrix aus `permissions.ts` in die Developer_Documentation generieren; vollständiges Beispiel für Maschinenzugänge (Authentifizierung, Listing mit Custom_Id anlegen, Abruf über Custom_Id, Status ändern, Historie, Wiederherstellung); Abschnitt zu Importmodi und Standard-Importmodus der mitgelieferten Module
    - _Requirements: 2.1, 12.16, 12.17, 16.4_

  - [ ]* 15.2 Dokumentationstests schreiben
    - Matrix in der Developer_Documentation stimmt mit `permissions.ts` überein; das Maschinenzugangs-Beispiel enthält alle geforderten Schritte
    - _Requirements: 2.1, 16.4_

- [ ] 16. Integrationstests
  - [ ]* 16.1 Integrationstests gegen die Testumgebung schreiben
    - Cognito-Login und JWT-Prüfung, 401 mit Audit-Eintrag; Rollenänderung, Agentursperre und Widerruf ≤ 60 s; Deaktivierung/Reaktivierung in DynamoDB- und OpenSearch-Suche ≤ 60 s; Transaktions-Abbruchgründe gegen DynamoDB Local; Löschung entfernt Versionen und S3-Snapshots; Nutzungszeilen ≤ 15 min in den Zählern; `RequestCount` und Alarmzustände abrufbar; manuell angelegtes Listing ohne Quell-URL erscheint in Search_API und MCP schemakonform mit Öffentlicher_Detail_URL
    - _Requirements: 1.6, 1.8, 2.8, 3.5, 4.15, 4.18, 6.3, 6.5, 9.2, 13.7, 14.1, 14.2_

- [ ] 17. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Jeder Task verweist auf konkrete Akzeptanzkriterien; alle 33 Correctness Properties sind genau einmal als PBT-Sub-Task abgebildet
- Die Admin_API bleibt in Schnittstelle und Verhalten unverändert; bestehende Tests von `real-estate-platform` laufen weiter, angepasst werden nur Lauf-Zähler (`unchanged`) und der Listing-Writer
- Keine Migration: es gibt keine bestehende Installation
- Checkpoints sichern die inkrementelle Validierung

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.6", "1.11", "1.12"] },
    { "id": 2, "tasks": ["1.3", "1.5", "1.7", "1.8", "2.1", "4.1", "4.8"] },
    { "id": 3, "tasks": ["1.9", "1.10", "2.2", "2.4", "2.6", "2.8", "4.2"] },
    { "id": 4, "tasks": ["2.3", "2.5", "2.7", "2.9", "4.3", "4.4", "4.5", "4.6", "4.7", "4.9", "4.15", "5.1", "6.1", "6.3", "9.1", "10.1"] },
    { "id": 5, "tasks": ["4.10", "4.11", "4.12", "4.13", "4.14", "5.2", "6.2", "6.4", "6.5", "10.2", "10.3", "10.4", "12.1", "12.3", "14.1"] },
    { "id": 6, "tasks": ["5.3", "6.6", "6.7", "8.1", "10.5", "12.5"] },
    { "id": 7, "tasks": ["6.8", "6.9", "8.2", "8.3", "10.6", "11.1"] },
    { "id": 8, "tasks": ["11.2", "11.3", "14.2"] },
    { "id": 9, "tasks": ["11.4"] },
    { "id": 10, "tasks": ["11.5"] },
    { "id": 11, "tasks": ["11.6"] },
    { "id": 12, "tasks": ["11.7", "11.8", "11.9"] },
    { "id": 13, "tasks": ["11.10", "12.2", "15.1"] },
    { "id": 14, "tasks": ["12.4", "14.3", "14.7", "14.8", "15.2"] },
    { "id": 15, "tasks": ["14.4", "14.9"] },
    { "id": 16, "tasks": ["14.5", "14.6", "14.10"] },
    { "id": 17, "tasks": ["16.1"] }
  ]
}
```
