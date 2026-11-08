# Requirements Document

## Introduction

Dieses Dokument beschreibt die Erweiterung der Platform (Specs `real-estate-platform` und `listing-management`) um eine automatische Duplikaterkennung für Listings sowie um zusätzliche, optionale Objektmerkmale, die eine zuverlässige Erkennung erst ermöglichen. Bisher verhindert die Platform Duplikate nur über die Custom_Id (eindeutig innerhalb einer Agentur) und über den Listing-Bezeichner beim Import. Ein wiederholter Anlageauftrag (z. B. nach einem Timeout) oder dieselbe Immobilie mit anderer Schreibweise erzeugt heute ein zweites, öffentlich sichtbares Listing.

Die Erweiterung umfasst:

- zusätzliche optionale Objektmerkmale (u. a. Hausnummer, Einheit, Etage, Baujahr, Grundstücksfläche, Flurstück), die je Immobiliengruppe in der Immobilien_Taxonomie freigegeben werden,
- eine reine, konfigurierbare Duplikat_Bewertung zweier Listings,
- eine Duplikat_Prüfung bei jedem Anlegen und Ändern über alle Kanäle (Management_API mit Agentur_Portal, Admin_Modus und Maschinenzugängen sowie Connector_Framework),
- Markierungen an Listings: Ein neu angelegtes Duplikat wird gespeichert, aber mit Listing_Status `INACTIVE` und einer Duplikat_Markierung; nur das Original bleibt öffentlich sichtbar. Berechtigte Akteure können die Markierung prüfen und das Listing trotzdem aktivieren,
- Schutz vor wiederholten Anlageaufträgen über einen Idempotenzschlüssel,
- einen täglichen Duplikat_Abgleich, der Markierungen innerhalb jedes Prüfbereichs abgleicht und agenturübergreifende Treffer ausschließlich für Plattform_Admins meldet.

Abweichend von Requirement 4.2 und 12.5 der Spec `listing-management` wird ein bei der Anlage erkanntes Duplikat unabhängig vom angeforderten bzw. standardmäßigen Listing_Status mit `INACTIVE` gespeichert. Abweichend von der Einleitung der Spec `listing-management` („das Listing-Schema bleibt unverändert“) erweitert diese Spec das Listing-Schema und das API_Schema der Öffentlichen_Schnittstellen um ausschließlich optionale Felder; alle bisher verpflichtenden Felder bleiben verpflichtend, und jedes bisher gültige Listing bleibt gültig. Requirement 4.7 der Spec `real-estate-platform` gilt für die neuen Wertebereiche entsprechend. Es gibt keine bestehende Installation, zu der Kompatibilität gewahrt werden muss.

Dieses Dokument konzentriert sich auf das *Was*. Technische Umsetzungsdetails werden im Design-Dokument behandelt.

## Glossary

Begriffe der Specs `real-estate-platform` und `listing-management` (u. a. Platform, Listing, Listing_Store, Listing_Inhalt, Inhaltsfeld, Inhalts_Hash, Listing_Status, Agentur, Akteur, Änderungskanal, Version, Custom_Id, Import_Datensatz, Connector_Framework, Connector_Lauf, Management_API, Agentur_Portal, Admin_Modus, Plattform_Admin, Maschinenzugang, Berechtigung, Audit_Log, Löschanfrage, Personenbezogenes_Feld, Immobilien_Taxonomie, Immobiliengruppe, Listing_Typ, Öffentliche_Schnittstellen, Öffentliche_Detail_URL, Monitoring_Kennzahl, Kennzahlenkatalog, Developer_Documentation) gelten unverändert. Zusätzlich gelten:

- **Objektmerkmal**: Ein optionales Inhaltsfeld, das diese Spec dem Listing_Inhalt hinzufügt (Requirement 1).
- **Bindbares Objektmerkmal**: Ein Objektmerkmal, dessen Zulässigkeit je Immobiliengruppe in der Immobilien_Taxonomie festgelegt wird (Requirement 2).
- **Merkmalsprofil**: Die normalisierte, für den Vergleich aufbereitete Darstellung des Listing_Inhalt eines Listings, die ausschließlich Werte, Hashwerte und Ähnlichkeitssignaturen enthält, die die Duplikat_Bewertung benötigt.
- **Duplikat_Bewertung**: Die reine Funktion, die für zwei Merkmalsprofile einen Übereinstimmungswert und die Übereinstimmungsgründe bestimmt und entscheidet, ob die beiden Listings Duplikate sind.
- **Übereinstimmungswert**: Eine Dezimalzahl von 0 bis 1, die angibt, wie stark zwei Listings übereinstimmen.
- **Übereinstimmungsgrund**: Ein stabiler, maschinenlesbarer Code, der ein zum Übereinstimmungswert beitragendes Signal benennt (z. B. `SAME_ADDRESS`, `GEO_NEAR`, `AREA_CLOSE`).
- **Schwellenwert**: Der konfigurierte Übereinstimmungswert, ab dem zwei Listings als Duplikate gelten.
- **Exakt_Duplikat**: Zwei Listings, deren Merkmalsprofile in allen Vergleichsbestandteilen gleich sind.
- **Prüfbereich**: Die Menge der Listings, innerhalb derer Duplikate markiert werden: alle Listings einer Agentur bzw. alle Listings ohne Agenturzuordnung.
- **Anlagezeitpunkt**: Der Zeitpunkt der Version 1 eines Listings.
- **Älteres Listing**: Von zwei Listings dasjenige mit dem früheren Anlagezeitpunkt, bei gleichem Anlagezeitpunkt das mit dem in Codepunkt-Reihenfolge kleineren Listing-Bezeichner.
- **Treffer**: Ein Listing desselben Prüfbereichs, mit dem ein Listing laut Duplikat_Bewertung Duplikat ist und dessen Paar nicht verworfen ist.
- **Original**: Das älteste Listing unter den Treffern eines Listings, die älter sind als dieses Listing.
- **Markierung**: Ein Verwaltungsvermerk an einem Listing mit Code, Zeitpunkt, Erkennungsweg und codespezifischen Angaben; Markierungen gehören nicht zum Listing_Inhalt.
- **Duplikat_Markierung**: Die Markierung mit dem Code `DUPLICATE`; sie nennt das Original und bis zu fünf Treffer mit Übereinstimmungswert und Übereinstimmungsgründen.
- **Erkennungsweg**: Der Vorgang, der eine Markierung gesetzt oder zuletzt geändert hat: `CREATE` (Anlage), `UPDATE` (Änderung) oder `SWEEP` (Duplikat_Abgleich).
- **Duplikat_Prüfung**: Die Bestimmung der Treffer und des Originals eines Listings innerhalb seines Prüfbereichs im Zuge eines Schreibvorgangs.
- **Duplikat_Index**: Der Datenbestand, über den die Platform Vergleichskandidaten eines Listings findet, einschließlich der gespeicherten Merkmalsprofile.
- **Verwerfung**: Die gespeicherte Entscheidung eines Akteurs, dass zwei bestimmte Listings keine Duplikate sind.
- **Duplikat_Abgleich**: Der geplante, prüfbereichsübergreifende Lauf, der Markierungen aller Listings neu bestimmt, den Duplikat_Index abgleicht und agenturübergreifende Treffer ermittelt.
- **Agenturübergreifender_Treffer**: Ein Paar von Listings aus verschiedenen Prüfbereichen, die laut Duplikat_Bewertung Duplikate sind, gespeichert als Meldung mit Zustand `OPEN`, `DISMISSED` oder `RESOLVED`.
- **Idempotenzschlüssel**: Ein vom Client gewählter Wert im Header `Idempotency-Key` eines Anlageauftrags, über den die Platform Wiederholungen desselben Auftrags erkennt.
- **Duplikat_Konfiguration**: Die optionale Konfigurationsdatei mit Gewichten, Toleranzen und Schwellenwert der Duplikat_Bewertung sowie der Uhrzeit des Duplikat_Abgleich.
- **Erkennungsschalter**: Die plattformweite Einstellung mit den Werten `enabled` und `disabled`, die bestimmt, ob die Duplikaterkennung läuft (Requirement 15).

## Requirements

### Requirement 1: Zusätzliche Objektmerkmale

**User Story:** Als Agentur_Mitglied möchte ich Immobilien genauer beschreiben (Hausnummer, Wohnungsnummer, Etage, Baujahr usw.), damit Interessenten mehr Informationen erhalten und die Platform dieselbe Immobilie sicher wiedererkennt.

#### Acceptance Criteria

1. THE Listing_Store SHALL für jedes Listing die folgenden optionalen Objektmerkmale speichern: Hausnummer (`address.houseNumber`, 1 bis 20 Zeichen), Einheit bzw. Wohnungsbezeichnung (`address.unit`, 1 bis 50 Zeichen), Etage (`floor`, Ganzzahl von -5 bis 200, 0 = Erdgeschoss), Anzahl Geschosse (`totalFloors`, Ganzzahl von 1 bis 200), Baujahr (`yearBuilt`, Ganzzahl von 1000 bis 2100), Grundstücksfläche (`plotArea`, Dezimalzahl mit höchstens zwei Nachkommastellen von 1 bis 10.000.000 Quadratmetern), Anzahl Schlafzimmer (`bedrooms`, Ganzzahl von 0 bis 99), Anzahl Badezimmer (`bathrooms`, Ganzzahl von 0 bis 99) und Flurstücks- bzw. Katasterbezeichnung (`parcelId`, 1 bis 100 Zeichen).
2. IF ein Listing_Inhalt sowohl Etage als auch Anzahl Geschosse enthält und die Etage größer als die Anzahl Geschosse ist, THEN THE Platform SHALL den Listing_Inhalt als ungültig abweisen und das Feld `floor` in der Fehlerbeschreibung nennen.
3. THE Management_API und THE Connector_Framework SHALL Objektmerkmale mit demselben Schema und denselben Wertebereichen validieren und jedes ungültige Objektmerkmal gemäß Requirement 4.4 der Spec `listing-management` bzw. Requirement 4.9 der Spec `real-estate-platform` einzeln benennen.
4. THE Platform SHALL Objektmerkmale als Inhaltsfelder behandeln, sodass sie in Inhalts_Hash, Importzusammenführung, Feldherkunft, Versionen und Diff wie die bisherigen Inhaltsfelder eingehen.
5. WHEN ein Listing über die Search_API oder den MCP_Server ausgeliefert wird, THE Öffentliche_Schnittstellen SHALL jedes gespeicherte Objektmerkmal im Listing-Datenmodell ausliefern und nicht gespeicherte Objektmerkmale weglassen, ohne sie mit einem Ersatzwert zu füllen.
6. THE API_Schema der Search_API und das OpenAPI-Dokument der Management_API SHALL jedes Objektmerkmal mit Datentyp und Wertebereich als optionales Feld beschreiben.
7. WHEN die öffentliche Detailansicht ein Listing anzeigt, THE Frontend SHALL jedes gespeicherte Objektmerkmal mit übersetzter Bezeichnung anzeigen.
8. THE Platform SHALL die Straßenangabe (`address.street`) weiterhin mit oder ohne Hausnummer annehmen und bei Angabe von `address.houseNumber` beide Werte unverändert speichern.
9. FOR ALL Listings, die vor dieser Erweiterung gültig waren, SHALL der Listing_Inhalt ohne Objektmerkmale weiterhin gültig sein und denselben Inhalts_Hash ergeben.

### Requirement 2: Bindung der Objektmerkmale an die Immobilien_Taxonomie

**User Story:** Als Administrator möchte ich festlegen, welche Objektmerkmale für welche Immobiliengruppe gelten, damit z. B. eine Etage nur bei Wohnungen und ein Flurstück nur bei Häusern und Grundstücken erfasst wird.

#### Acceptance Criteria

1. THE Platform SHALL in der Konfiguration der Immobilien_Taxonomie je Immobiliengruppe eine optionale Liste zulässiger Bindbarer_Objektmerkmale aus `address.unit`, `floor`, `totalFloors`, `yearBuilt`, `plotArea`, `bedrooms`, `bathrooms` und `parcelId` annehmen; `address.houseNumber` ist für jede Immobiliengruppe zulässig.
2. WHERE eine Immobiliengruppe keine Liste zulässiger Bindbarer_Objektmerkmale angibt, THE Platform SHALL für diese Immobiliengruppe alle Bindbaren_Objektmerkmale zulassen.
3. THE Platform SHALL in der Standard-Taxonomie für die Immobiliengruppe Wohnung `address.unit`, `floor`, `totalFloors`, `yearBuilt`, `bedrooms` und `bathrooms`, für Haus `totalFloors`, `yearBuilt`, `plotArea`, `bedrooms`, `bathrooms` und `parcelId`, für Grundstück `plotArea` und `parcelId` und für Gewerbe `address.unit`, `floor`, `totalFloors`, `yearBuilt`, `plotArea` und `parcelId` zulassen.
4. IF die Konfiguration der Immobilien_Taxonomie beim Start einen unbekannten Merkmalscode oder einen Merkmalscode mehrfach für dieselbe Immobiliengruppe enthält, THEN THE Platform SHALL den Start gemäß Requirement 15.4 der Spec `real-estate-platform` abbrechen und jeden betroffenen Merkmalscode mit seiner Immobiliengruppe und der Art des Verstoßes benennen.
5. WHEN ein Listing_Inhalt über einen beliebigen Änderungskanal ein Bindbares_Objektmerkmal enthält, das für die Immobiliengruppe seines Listing_Typ nicht zulässig ist, THE Platform SHALL dieses Objektmerkmal verwerfen, den Listing_Inhalt mit allen übrigen Feldern weiterverarbeiten und den Feldnamen ohne Wert in der Antwort der Management_API (`droppedFields`) bzw. im Protokoll des Connector_Lauf nennen.
6. THE Search_API SHALL im Discovery-Endpunkt und im API_Schema je Immobiliengruppe die zulässigen Bindbaren_Objektmerkmale in maschinenlesbarer Form angeben.
7. WHILE ein Benutzer im Agentur_Portal ein Listing bearbeitet, THE Agentur_Portal SHALL Eingabefelder genau für die Objektmerkmale anzeigen, die für die Immobiliengruppe des gewählten Listing_Typ zulässig sind, und Werte nicht mehr zulässiger Objektmerkmale nach einem Wechsel des Listing_Typ nicht an die Management_API senden.

### Requirement 3: Duplikat_Bewertung

**User Story:** Als Betreiber möchte ich eine nachvollziehbare, einheitliche Regel, wann zwei Listings dieselbe Immobilie beschreiben, damit Erkennung beim Schreiben und im täglichen Abgleich zum selben Ergebnis kommt.

#### Acceptance Criteria

1. THE Platform SHALL den Übereinstimmungswert und die Übereinstimmungsgründe zweier Listings ausschließlich aus deren Listing_Inhalt bestimmen, unabhängig von Listing-Bezeichner, Listing_Status, Custom_Id, Agentur, Markierungen, Provenienzfeldern, einer abgeleiteten Öffentlichen_Detail_URL als Quell-URL und der Reihenfolge von Medien und Sprachfassungen.
2. WHEN die Platform Adressen und Texte vergleicht, THE Platform SHALL Unterschiede in Groß- und Kleinschreibung, Unicode-Normalform, Leerraum, Satzzeichen, Diakritika, der Schreibweise „ß“/„ss“ und den Schreibweisen des Straßenzusatzes („Straße“, „Strasse“, „Str.“) sowie die Angabe der Hausnummer im Straßenfeld oder in `address.houseNumber` als gleichwertig behandeln.
3. THE Platform SHALL zwei Listings nicht als Duplikate bewerten, wenn ihr Land verschieden ist, ihre Listing_Typen verschiedenen Immobiliengruppen angehören, sie keine gemeinsame Angebotsart haben oder ein bei beiden vorhandener Wert aus normalisierter Adresse mit Hausnummer, Einheit, Etage und Flurstück verschieden ist.
4. THE Platform SHALL zwei Listings nur dann als Duplikate bewerten, wenn mindestens ein Ortsanker vorliegt: gleiche normalisierte Adresse mit Hausnummer, Geokoordinaten mit höchstens 50 m Abstand, gleiche Flurstücksbezeichnung, gleiche nicht abgeleitete Quell-URL oder gleiche Postleitzahl zusammen mit nahezu gleichem Titel und nahezu gleicher Beschreibung in der Originalsprache.
5. THE Platform SHALL zwei Listings genau dann als Duplikate bewerten, wenn kein Ausschlusskriterium aus Kriterium 3 zutrifft, ein Ortsanker aus Kriterium 4 vorliegt und der Übereinstimmungswert mindestens dem Schwellenwert entspricht.
6. WHEN zwei Listings Exakt_Duplikate sind und kein Ausschlusskriterium zutrifft, THE Platform SHALL den Übereinstimmungswert 1 und den Übereinstimmungsgrund `EXACT` bestimmen.
7. FOR ALL Paare von Listings SHALL die Duplikat_Bewertung symmetrisch und deterministisch sein und einen Übereinstimmungswert von 0 bis 1 liefern.
8. THE Platform SHALL Gewichte, Toleranzen und Schwellenwert der Duplikat_Bewertung aus der Duplikat_Konfiguration beziehen und ohne Duplikat_Konfiguration die in der Developer_Documentation dokumentierten Standardwerte verwenden.
9. IF die Duplikat_Konfiguration beim Start ungültig ist, THEN THE Platform SHALL den Start abbrechen, keine Anfragen annehmen und jeden ungültigen Wert mit Feldname und Art des Verstoßes benennen.
10. THE Platform SHALL jeden Übereinstimmungsgrund als stabilen, maschinenlesbaren Code ausgeben und den Katalog der Codes in der Developer_Documentation veröffentlichen.

### Requirement 4: Prüfbereich, Treffer und Original

**User Story:** Als Agentur_Mitglied möchte ich, dass nur unsere eigenen Listings gegeneinander geprüft werden und immer das zuerst angelegte Listing online bleibt, damit das Ergebnis vorhersehbar ist und keine fremde Agentur unsere Listings beeinflusst.

#### Acceptance Criteria

1. THE Platform SHALL als Prüfbereich eines Listings seine Eigentümer-Agentur bzw. für Listings ohne Agenturzuordnung die Menge aller Listings ohne Agenturzuordnung verwenden.
2. THE Platform SHALL ein Listing mit allen Listings seines Prüfbereichs unabhängig von deren Listing_Status vergleichen, ausgenommen das Listing selbst und Listings, mit denen eine Verwerfung besteht.
3. THE Platform SHALL ein Listing genau dann als Duplikat einstufen, wenn mindestens ein Treffer ein Älteres_Listing ist.
4. THE Platform SHALL als Original eines als Duplikat eingestuften Listings den ältesten seiner Treffer bestimmen.
5. THE Platform SHALL Listings verschiedener Prüfbereiche ausschließlich im Duplikat_Abgleich und ausschließlich gemäß Requirement 11 vergleichen.

### Requirement 5: Duplikat_Prüfung bei der Anlage

**User Story:** Als Agentur_Mitglied möchte ich, dass ein versehentlich doppelt angelegtes Listing zwar gespeichert, aber nicht veröffentlicht wird, damit ich es prüfen kann und Interessenten die Immobilie nur einmal sehen.

#### Acceptance Criteria

1. WHEN ein Listing über die Management_API (Änderungskanäle `PORTAL`, `API` und `ADMIN`) oder über das Connector_Framework angelegt wird, THE Platform SHALL vor dem Speichern die Duplikat_Prüfung ausführen.
2. IF die Duplikat_Prüfung ein neu anzulegendes Listing als Duplikat einstuft, THEN THE Platform SHALL das Listing mit dem Listing_Status `INACTIVE` und einer Duplikat_Markierung mit Erkennungsweg `CREATE` anlegen, unabhängig vom im Anlageauftrag angegebenen bzw. beim Import standardmäßigen Listing_Status.
3. WHEN ein Listing als Duplikat angelegt wurde, THE Management_API SHALL mit dem Statuscode 201 und der Darstellung des Listings einschließlich gespeichertem Listing_Status und Duplikat_Markierung antworten.
4. WHEN ein Listing als Duplikat angelegt wurde, THE Platform SHALL in Version 1 als Statusbegründung `DUPLICATE` mit dem Original speichern.
5. WHEN das Connector_Framework ein Listing als Duplikat anlegt, THE Connector_Framework SHALL es als angelegt zählen, zusätzlich im Zähler `flagged` des Connector_Lauf erfassen und Listing-Bezeichner, Original und Übereinstimmungsgründe ohne Werte von Inhaltsfeldern protokollieren.
6. IF die Duplikat_Prüfung ein neu anzulegendes Listing nicht als Duplikat einstuft, THEN THE Platform SHALL das Listing gemäß Requirement 4 der Spec `listing-management` bzw. Requirement 12.5 derselben Spec ohne Duplikat_Markierung anlegen.
7. THE Management_API SHALL Anlageaufträge einschließlich Duplikat_Prüfung bei bis zu 200 Vergleichskandidaten mit einer zusätzlichen Latenz von höchstens 300 ms (p95) gegenüber der Anlage ohne Duplikat_Prüfung beantworten.
8. IF der Duplikat_Index bei einem Anlageauftrag der Management_API nicht innerhalb der Deadline erreichbar ist, THEN THE Management_API SHALL den Statuscode 503 mit dem Fehlercode `SERVICE_UNAVAILABLE` zurückgeben und nichts speichern.
9. IF der Duplikat_Index bei der Verarbeitung eines Import_Datensatz nicht erreichbar ist, THEN THE Connector_Framework SHALL den Import_Datensatz nicht speichern und die Abweisung mit dem Grund „Duplikatprüfung nicht verfügbar“ protokollieren.

### Requirement 6: Duplikat_Prüfung bei Änderungen

**User Story:** Als Agentur_Mitglied möchte ich erfahren, wenn ein Listing durch eine Bearbeitung oder einen Import zu einem Duplikat wird, ohne dass ein bereits veröffentlichtes Listing ungefragt offline geht.

#### Acceptance Criteria

1. WHEN der Listing_Inhalt oder die Eigentümer-Agentur eines Listings über einen beliebigen Änderungskanal geändert wird (Bearbeitung, Wiederherstellung, Agenturzuweisung, Import), THE Platform SHALL die Duplikat_Prüfung für dieses Listing ausführen und seine Duplikat_Markierung atomar mit der Änderung setzen, aktualisieren oder entfernen, sodass sie danach Requirement 4 entspricht.
2. THE Platform SHALL bei einer Änderung gemäß Kriterium 1 den Listing_Status nie aufgrund der Duplikat_Prüfung verändern.
3. WHEN eine Duplikat_Markierung bei einer Änderung gesetzt oder geändert wird, THE Platform SHALL den Erkennungsweg `UPDATE` speichern.
4. WHEN eine Änderung ausschließlich den Listing_Status oder die Custom_Id betrifft, THE Platform SHALL die Duplikat_Markierung unverändert lassen, ausgenommen die Freigabe gemäß Requirement 8.1.
5. WHEN ein Änderungsauftrag der Management_API erfolgreich ist, THE Management_API SHALL in der Antwort die aktuellen Markierungen des Listings zurückgeben.

### Requirement 7: Markierungen

**User Story:** Als Entwickler der Platform möchte ich Markierungen als allgemeinen Mechanismus, damit später weitere Markierungsarten neben Duplikaten hinzukommen können.

#### Acceptance Criteria

1. THE Platform SHALL je Listing eine Menge von Markierungen mit höchstens einer Markierung je Code speichern, jede mit Code, Zeitpunkt der letzten Änderung, Erkennungsweg und codespezifischen Angaben.
2. THE Platform SHALL für die Duplikat_Markierung das Original und bis zu fünf Treffer, absteigend nach Übereinstimmungswert, jeweils mit Listing-Bezeichner, Übereinstimmungswert und Übereinstimmungsgründen speichern.
3. THE Platform SHALL Markierungen nicht als Teil des Listing_Inhalt behandeln, sodass sie weder in den Inhalts_Hash eingehen noch für sich allein eine Version erzeugen.
4. THE Öffentliche_Schnittstellen SHALL Markierungen nie ausliefern.
5. WHEN ein Akteur mit Berechtigung `listing:read` ein Listing abruft oder Listings auflistet, THE Management_API SHALL die Markierungen jedes Listings zurückgeben und einen Filter nach Markierungscode anbieten.
6. THE Management_API SHALL Akteuren einer Agentur in Markierungen ausschließlich Listing-Bezeichner von Listings ihres eigenen Prüfbereichs zurückgeben.
7. WHEN eine Markierung gesetzt, geändert oder entfernt wird, THE Platform SHALL einen Eintrag im Audit_Log mit Akteur (Benutzer, Maschinenzugang, Connector oder der Duplikat_Abgleich als System-Akteur), Listing-Bezeichner, Markierungscode und Übereinstimmungsgründen ohne Werte von Inhaltsfeldern speichern.
8. WHEN ein neuer Markierungscode hinzugefügt wird, THE Management_API SHALL Antworten für bestehende Markierungscodes in Feldnamen und Datentypen unverändert lassen.

### Requirement 8: Freigabe und Verwerfen von Duplikat_Markierungen

**User Story:** Als Agentur_Mitglied möchte ich ein fälschlich als Duplikat erkanntes Listing trotzdem veröffentlichen oder die Markierung entfernen, damit ein Fehler der Erkennung meine Arbeit nicht blockiert.

#### Acceptance Criteria

1. WHEN ein Akteur mit Berechtigung `listing:status` ein Listing mit Duplikat_Markierung auf `ACTIVE` setzt, THE Platform SHALL das Listing aktivieren und atomar mit der Statusänderung die Duplikat_Markierung entfernen und für jedes Paar aus dem Listing und einem seiner Treffer zum Zeitpunkt der Freigabe eine Verwerfung speichern, auch für Treffer, die nicht in der Duplikat_Markierung genannt sind.
2. WHEN ein Akteur mit Berechtigung `listing:status` die Duplikat_Markierung eines Listings seiner Agentur verwirft, THE Platform SHALL die Duplikat_Markierung entfernen, für jedes Paar aus dem Listing und einem seiner Treffer zum Zeitpunkt der Verwerfung eine Verwerfung speichern, den Listing_Status unverändert lassen und keine Version erzeugen.
3. WHILE für ein Paar von Listings eine Verwerfung besteht, THE Platform SHALL die beiden Listings bei Duplikat_Prüfung und Duplikat_Abgleich nicht als Treffer voneinander behandeln.
4. WHEN ein Akteur die Duplikat_Markierung eines Listings verwirft, das keine Duplikat_Markierung hat, THE Management_API SHALL erfolgreich antworten, ohne den Datenbestand zu verändern.
5. WHEN ein Benutzer im Agentur_Portal ein Listing mit Duplikat_Markierung aktiviert, THE Agentur_Portal SHALL vor der Ausführung das Original und die Übereinstimmungsgründe anzeigen und eine Bestätigung verlangen.
6. FOR ALL Listings ohne Duplikat_Markierung SHALL das Aktivieren und Deaktivieren gemäß Requirement 6 der Spec `listing-management` unverändert bleiben.

### Requirement 9: Nebenläufige und wiederholte Anlageaufträge

**User Story:** Als Entwickler einer Agentur-Integration möchte ich einen Anlageauftrag nach einem Timeout gefahrlos wiederholen können, damit meine Integration keine doppelten Listings erzeugt.

#### Acceptance Criteria

1. FOR ALL nebenläufigen Anlagen von Exakt_Duplikaten innerhalb eines Prüfbereichs SHALL höchstens eines der angelegten Listings ohne Duplikat_Markierung gespeichert werden.
2. WHEN ein Anlageauftrag der Management_API einen Idempotenzschlüssel (1 bis 128 druckbare ASCII-Zeichen) enthält, mit dem derselbe Akteur innerhalb der letzten 24 Stunden bereits ein Listing angelegt hat, und der Auftrag in kanonischer Darstellung gleich dem ursprünglichen Auftrag ist, THE Management_API SHALL den Statuscode 201 mit der aktuellen Darstellung dieses Listings und dem Header `Idempotent-Replayed: true` zurückgeben, ohne ein weiteres Listing oder eine Version anzulegen.
3. IF ein Anlageauftrag einen Idempotenzschlüssel enthält, den derselbe Akteur innerhalb der letzten 24 Stunden für einen abweichenden Auftrag verwendet hat, THEN THE Management_API SHALL den Statuscode 409 mit dem Fehlercode `IDEMPOTENCY_KEY_REUSED` zurückgeben und den Datenbestand unverändert lassen.
4. THE Management_API SHALL Idempotenzschlüssel je Akteur (Benutzer bzw. Maschinenzugang) auswerten, sodass gleiche Schlüssel verschiedener Akteure sich nicht beeinflussen.
5. IF ein Idempotenzschlüssel nicht dem Format aus Kriterium 2 entspricht, THEN THE Management_API SHALL den Statuscode 400 mit dem Fehlercode `INVALID_PARAMETER` und dem Feld `Idempotency-Key` zurückgeben, ohne den Auftrag auszuführen.
6. WHERE ein Anlageauftrag keinen Idempotenzschlüssel enthält, THE Management_API SHALL den Auftrag ohne Wiederholungserkennung ausführen.

### Requirement 10: Täglicher Duplikat_Abgleich

**User Story:** Als Betreiber möchte ich einen täglichen Abgleich, damit Duplikate, die beim Schreiben nicht erkennbar waren (gleichzeitige Anlage, geänderte Regeln, Listings außerhalb der Schreibwege), spätestens am nächsten Tag markiert sind.

#### Acceptance Criteria

1. THE Platform SHALL den Duplikat_Abgleich über alle Listings einmal je Kalendertag (UTC) zu der in der Duplikat_Konfiguration angegebenen Uhrzeit, ohne Angabe um 03:00 UTC, ausführen.
2. WHEN ein Akteur mit Berechtigung `platform:operate` den Duplikat_Abgleich über die Management_API startet, THE Platform SHALL einen Duplikat_Abgleich starten, sofern keiner läuft, und andernfalls die Kennung des laufenden Duplikat_Abgleich zurückgeben.
3. WHEN der Duplikat_Abgleich ein Listing prüft, THE Platform SHALL dessen Duplikat_Markierung gemäß Requirement 4 setzen, aktualisieren oder entfernen, den Erkennungsweg `SWEEP` speichern, den Listing_Status unverändert lassen und keine Version erzeugen.
4. THE Duplikat_Abgleich SHALL den Duplikat_Index aus den gespeicherten Listings neu bestimmen, sodass nach einem vollständigen Lauf der Duplikat_Index dem Listing_Store entspricht, auch für Listings, die nicht über die Management_API oder das Connector_Framework geschrieben wurden.
5. IF ein Listing während des Duplikat_Abgleich geändert wird, THEN THE Duplikat_Abgleich SHALL die Markierung dieses Listings nicht überschreiben und es im nächsten Lauf erneut prüfen.
6. WHEN die Duplikat_Konfiguration geändert wurde, THE Platform SHALL die geänderten Regeln spätestens im nächsten vollständigen Duplikat_Abgleich auf alle Listings anwenden.
7. WHEN ein Duplikat_Abgleich endet, THE Platform SHALL Startzeitpunkt, Endzeitpunkt, Ergebnisstatus, Anzahl geprüfter Listings, gesetzter, geänderter und entfernter Duplikat_Markierungen sowie neuer und aufgelöster Agenturübergreifender_Treffer ohne Werte von Inhaltsfeldern protokollieren.
8. IF ein Duplikat_Abgleich fehlschlägt oder nicht innerhalb von 4 Stunden endet, THEN THE Platform SHALL ihn als fehlgeschlagen protokollieren und einen Alarm auslösen.
9. THE Duplikat_Abgleich SHALL bei bis zu 1.000.000 Listings innerhalb von 4 Stunden enden.

### Requirement 11: Agenturübergreifende Treffer

**User Story:** Als Plattform_Admin möchte ich sehen, welche Immobilien von mehreren Agenturen angeboten werden, ohne dass eine Agentur dadurch Listings einer anderen Agentur beeinflussen kann.

#### Acceptance Criteria

1. WHEN der Duplikat_Abgleich zwei Listings verschiedener Prüfbereiche als Duplikate bewertet, THE Platform SHALL einen Agenturübergreifenden_Treffer mit beiden Listing-Bezeichnern, beiden Agenturen, Übereinstimmungswert, Übereinstimmungsgründen, Zeitpunkt der ersten und der letzten Feststellung und Zustand `OPEN` speichern bzw. einen bestehenden Treffer für dasselbe Paar aktualisieren.
2. THE Platform SHALL aufgrund eines Agenturübergreifenden_Treffer weder den Listing_Status noch die Markierungen eines Listings verändern.
3. WHEN ein Plattform_Admin die Agenturübergreifenden_Treffer abruft, THE Management_API SHALL sie paginiert, absteigend nach Übereinstimmungswert, mit Filtern nach Zustand und Agentur zurückgeben.
4. THE Management_API SHALL das Abrufen und Verwerfen Agenturübergreifender_Treffer ausschließlich Akteuren mit der Berechtigung `duplicate:review` erlauben, die ausschließlich die Rolle Plattform_Admin besitzt und für Maschinenzugänge nicht gewährbar ist.
5. WHEN ein Plattform_Admin einen Agenturübergreifenden_Treffer verwirft, THE Platform SHALL dessen Zustand auf `DISMISSED` setzen und ihn in nachfolgenden Duplikat_Abgleichen nicht wieder auf `OPEN` setzen, solange beide Listings bestehen.
6. WHEN der Duplikat_Abgleich feststellt, dass die Listings eines Agenturübergreifenden_Treffer mit Zustand `OPEN` nicht mehr Duplikate sind, THE Platform SHALL dessen Zustand auf `RESOLVED` setzen.
7. THE Admin_Modus SHALL eine Ansicht der Agenturübergreifenden_Treffer mit Filtern, Verweisen auf beide Listings und einem Bedienelement zum Verwerfen bereitstellen.

### Requirement 12: Datenschutz und Löschung

**User Story:** Als Plattform_Admin möchte ich, dass die Duplikaterkennung keine zusätzlichen personenbezogenen Daten anhäuft und bei Löschanfragen vollständig bereinigt wird, damit die Platform DSGVO-konform bleibt.

#### Acceptance Criteria

1. THE Platform SHALL im Duplikat_Index Straße, Hausnummer, Einheit, Flurstücksbezeichnung, Quell-URL und Medien-URLs ausschließlich als Hashwerte und Titel und Beschreibung ausschließlich als Ähnlichkeitssignaturen speichern und keine Personenbezogenen_Felder aufnehmen.
2. THE Platform SHALL in Markierungen, Verwerfungen, Agenturübergreifenden_Treffern, Audit-Einträgen und Protokollen des Duplikat_Abgleich ausschließlich Listing-Bezeichner, Agentur-Bezeichner, Übereinstimmungswerte, Übereinstimmungsgründe und Zeitpunkte speichern.
3. WHEN eine Löschanfrage gemäß Requirement 18.4 der Spec `real-estate-platform` ausgeführt wird, THE Platform SHALL innerhalb derselben Frist alle Einträge des Duplikat_Index einschließlich der vom betroffenen Listing gespeicherten Verwerfungen, alle Agenturübergreifenden_Treffer und alle Idempotenzschlüssel-Einträge der betroffenen Listings entfernen und die Löschanfrage erst dann als ausgeführt führen.
4. WHEN ein Listing entfernt wurde, THE Platform SHALL Duplikat_Markierungen anderer Listings, die das entfernte Listing nennen, spätestens im nächsten Duplikat_Abgleich gemäß Requirement 4 neu bestimmen und Verwerfungen anderer Listings, die den Bezeichner des entfernten Listings enthalten, spätestens im nächsten Duplikat_Abgleich entfernen.

### Requirement 13: Agentur_Portal und Admin_Modus

**User Story:** Als Agentur_Mitglied möchte ich Duplikat_Markierungen im Portal sehen und bearbeiten, damit ich ohne API-Kenntnisse entscheiden kann, welches Listing online geht.

#### Acceptance Criteria

1. THE Agentur_Portal SHALL in der Listing-Übersicht Listings mit Duplikat_Markierung hervorheben und einen Filter nach Markierungscode bereitstellen.
2. WHEN ein Benutzer ein Listing mit Duplikat_Markierung öffnet, THE Agentur_Portal SHALL einen Hinweis mit Original (als Verweis), Übereinstimmungswert und übersetzten Übereinstimmungsgründen anzeigen und gemäß den Berechtigungen des Benutzers Bedienelemente zum Aktivieren (Requirement 8.5) und zum Verwerfen der Markierung anbieten.
3. WHEN die Management_API auf einen Anlageauftrag aus dem Agentur_Portal ein als Duplikat angelegtes Listing zurückgibt, THE Agentur_Portal SHALL den Benutzer darauf hinweisen, dass das Listing als mögliches Duplikat inaktiv gespeichert wurde.
4. THE Agentur_Portal SHALL in der Versionshistorie eine Version mit Statusbegründung `DUPLICATE` als automatische Deaktivierung mit Verweis auf das Original kennzeichnen.
5. THE Agentur_Portal und THE Admin_Modus SHALL alle neuen Texte über Übersetzungsschlüssel gemäß Requirement 13 der Spec `real-estate-platform` auflösen und gemäß `docs/design/README.md` gestalten.

### Requirement 14: API, Dokumentation und Monitoring

**User Story:** Als Entwickler einer Agentur möchte ich die Duplikaterkennung vollständig über die dokumentierte API nutzen, damit meine Integration Duplikate erkennen und behandeln kann.

#### Acceptance Criteria

1. THE Management_API SHALL für jede Operation dieser Spec im Agentur_Portal und im Admin_Modus einen Endpunkt mit derselben Validierung, denselben Berechtigungsprüfungen und denselben Fehlercodes bereitstellen.
2. THE OpenAPI-Dokument der Management_API SHALL Objektmerkmale, Markierungen, den Markierungsfilter, den Header `Idempotency-Key`, die Endpunkte zum Verwerfen, zum Starten des Duplikat_Abgleich und für Agenturübergreifende_Treffer mit erforderlicher Berechtigung, Parametern, Antworten und Fehlercodes beschreiben.
3. THE Platform SHALL den Fehlercode `IDEMPOTENCY_KEY_REUSED` (Statuscode 409) im gemeinsamen Fehlerkatalog ergänzen.
4. THE Developer_Documentation SHALL die Regeln der Duplikat_Bewertung mit Standardwerten, den Katalog der Übereinstimmungsgründe, die Duplikat_Konfiguration, die Objektmerkmale mit ihrer Taxonomie-Bindung sowie je ein vollständiges Beispiel für die Anlage eines Duplikats mit anschließender Freigabe und für einen wiederholten Anlageauftrag mit Idempotenzschlüssel enthalten.
5. THE Management_API SHALL die Monitoring_Kennzahl `listing.duplicate_flags` (Anzahl der Listings mit Duplikat_Markierung je Agentur, Geltungsbereich Agentur) und die Monitoring_Kennzahl `duplicate.cross_agency_open` (Anzahl Agenturübergreifender_Treffer mit Zustand `OPEN`, Geltungsbereich plattformweit) im Kennzahlenkatalog bereitstellen.
6. THE Developer_Documentation SHALL die Berechtigung `duplicate:review` in der aus `shared/permissions.ts` generierten Berechtigungsmatrix enthalten.

### Requirement 15: Ein- und Ausschalten der Duplikaterkennung

**User Story:** Als Plattform_Admin möchte ich die Duplikaterkennung bei der Bereitstellung und im laufenden Betrieb ein- und ausschalten können, damit ich ihre Kosten vermeiden kann, solange sie sich nicht lohnt, und sie ohne Datenverlust wieder aufnehmen kann.

#### Acceptance Criteria

1. THE Platform SHALL den Erkennungsschalter als plattformweite Einstellung mit den Werten `enabled` und `disabled` führen; ohne gespeicherten Wert gilt `enabled`.
2. THE Bereitstellung SHALL den Anfangswert des Erkennungsschalters über einen Konfigurationswert festlegen und einen ungültigen Wert mit einer Fehlermeldung ablehnen, die den Konfigurationswert benennt.
3. THE Management_API SHALL einen Endpunkt zum Lesen und einen zum Setzen des Erkennungsschalters bereitstellen, die ausschließlich Akteuren mit der Berechtigung `platform:operate` zur Verfügung stehen; jede Änderung SHALL im Audit_Log protokolliert werden.
4. THE Admin_Modus SHALL den Erkennungsschalter im Bereich Betrieb anzeigen und umschaltbar machen und vor dem Ausschalten eine Bestätigung einholen, die nennt, was entfällt und was erhalten bleibt.
5. WHILE der Erkennungsschalter `disabled` ist, THE Platform SHALL Listings bei Anlage, Änderung und Import ohne Duplikat_Prüfung mit dem angeforderten Listing_Status speichern, keine Markierung setzen oder ändern und den Duplikat_Index nicht fortschreiben.
6. WHILE der Erkennungsschalter `disabled` ist, THE Duplikat_Abgleich SHALL unmittelbar nach dem Start ohne Lesen der Listings enden und den Lauf als übersprungen protokollieren, und der manuelle Start SHALL mit dem Fehlercode `DUPLICATE_DETECTION_DISABLED` (Statuscode 409) abgelehnt werden.
7. WHILE der Erkennungsschalter `disabled` ist, THE Platform SHALL bestehende Markierungen und Agenturübergreifende_Treffer unverändert anzeigen und ihre Freigabe und ihr Verwerfen zulassen; eine Freigabe SHALL Verwerfungen gegen die in der Duplikat_Markierung genannten Treffer speichern.
8. WHEN der Erkennungsschalter im laufenden Betrieb auf `enabled` gesetzt wird, THE Platform SHALL einen Duplikat_Abgleich starten, der den Duplikat_Index neu aufbaut und alle Markierungen neu bestimmt.
9. WHEN der Erkennungsschalter geändert wird, THE Platform SHALL den neuen Wert innerhalb von 60 Sekunden ohne Neustart und ohne erneute Bereitstellung in allen Schreibwegen anwenden.
10. IF der Erkennungsschalter nicht gelesen werden kann und kein zuvor gelesener Wert vorliegt, THEN THE Platform SHALL den Schreibvorgang wie bei nicht erreichbarem Duplikat_Index ablehnen.

## Abgrenzung

Nicht Bestandteil dieser Spec: Vergleich von Bildinhalten (z. B. Perceptual Hashing; erst mit plattformeigener Medienablage sinnvoll), Suchfilter der Search_API für die neuen Objektmerkmale, automatisches Zusammenführen oder Löschen von Duplikaten, Benachrichtigungen an Agenturen, agenturspezifische Gewichte oder Schwellenwerte, lernende Verfahren zur Duplikat_Bewertung, Deaktivierung durch den Duplikat_Abgleich, jede Auswirkung Agenturübergreifender_Treffer auf Listings sowie Hinweise an Agenturen auf Listings anderer Agenturen. Weitere Objektmerkmale (z. B. Energieeffizienzklasse, Heizungsart, Stellplätze, Ausstattung) werden in einer späteren Erweiterung ergänzt.
