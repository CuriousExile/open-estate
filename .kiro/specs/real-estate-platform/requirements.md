# Requirements Document

## Introduction

Dieses Dokument beschreibt die Anforderungen an eine quelloffene Immobilien-Plattform. Die Plattform besteht aus einem Web-Frontend für menschliche Nutzer und einem Backend mit einer AI-/Agent-freundlichen Such-API, über die AI-Agents und AI-Tools strukturiert nach Immobilien suchen können.

Die Plattform wird auf AWS betrieben und stellt ihre APIs über AWS API Gateway bereit. Ein zentrales Gestaltungsprinzip ist maximale Adaptierbarkeit: Da die Plattform Open Source ist, müssen Branding, Theming und Texte des Frontends ohne Code-Änderungen über Konfiguration anpassbar sein (White-Labeling). Die Datenbeschaffung erfolgt über eine erweiterbare Connector-Architektur, die bestehende Datenbanken, externe APIs und einen rechtskonformen Webcrawler einbinden kann.

Dieses Dokument konzentriert sich auf das *Was* (fachliche Anforderungen). Technische Umsetzungsdetails werden im Design-Dokument behandelt.

## Glossary

- **Platform**: Das Gesamtsystem bestehend aus Frontend, Backend-API und Datenbeschaffungsschicht.
- **Search_API**: Die über AWS API Gateway bereitgestellte Programmierschnittstelle zum Suchen und Abrufen von Immobilien-Listings.
- **Frontend**: Die browserbasierte Benutzeroberfläche (bevorzugt Angular) für menschliche Nutzer.
- **AI_Agent**: Ein automatisierter Software-Client (AI-Agent oder AI-Tool), der die Search_API programmatisch konsumiert.
- **Listing**: Ein Datensatz, der eine einzelne Immobilie mit ihren Attributen (Ort, Preis, Zimmeranzahl, Fläche, Typ etc.) repräsentiert.
- **Listing_Store**: Die persistente Datenhaltung, in der normalisierte Listings gespeichert werden.
- **Listing_Typ**: Die Kategorie einer Immobilie aus der definierten Werteliste der zulässigen Immobilientypen, die bestimmt, welche Pflichtfelder für ein Listing gelten.
- **Connector**: Eine austauschbare Komponente, die Immobiliendaten aus einer externen Quelle (Datenbank, API oder Webseite) in das normalisierte Listing-Format importiert.
- **Connector_Framework**: Die Backend-Komponente, die Connectors registriert, konfiguriert und ausführt.
- **Connector_Lauf**: Eine einzelne Ausführung eines Connectors durch das Connector_Framework von Start bis Abschluss.
- **Crawler_Connector**: Ein spezieller Connector, der Immobiliendaten durch Crawlen von Webseiten bezieht.
- **Crawl_Lauf**: Eine einzelne Ausführung des Crawler_Connector über eine oder mehrere Zielseiten von Start bis Abschluss.
- **Compliance_Checker**: Die Komponente, die vor einem Crawl die rechtliche Zulässigkeit (robots.txt, Nutzungsbedingungen, konfigurierte Erlaubnislisten) prüft.
- **Zielseite**: Eine vom Crawler_Connector abzurufende Webseite, die als Datenquelle für Immobiliendaten dient.
- **Erlaubnisliste**: Die vom Administrator konfigurierte Liste der Zielseiten, die gecrawlt werden dürfen.
- **Theme_Config**: Die Konfigurationsquelle, die Branding-Werte (Logo, Farben, Texte) für das Frontend bereitstellt.
- **API_Schema**: Die maschinenlesbare Beschreibung der Search_API (z. B. OpenAPI-Dokument) inklusive Endpunkten, Parametern und Datenmodellen.
- **Developer_Documentation**: Die für Entwickler und Mitwirkende bereitgestellte Dokumentation (Installation, Erweiterung, Theming, API, Connectors) im Quellcode-Repository.
- **Administrator**: Eine Person, die die Platform betreibt, konfiguriert und Connectors sowie Theming verwaltet.
- **Search_Filter**: Die Menge strukturierter Suchkriterien (z. B. Ort, Preisbereich, Zimmeranzahl, Flächenbereich, Immobilientyp).

## Requirements

### Requirement 1: Strukturierte Immobiliensuche über die API

**User Story:** Als AI_Agent möchte ich über eine strukturierte API nach Immobilien mit definierten Filterkriterien suchen, damit ich passende Listings programmatisch abrufen kann.

#### Acceptance Criteria

1. WHEN die Search_API eine Suchanfrage mit einem oder mehreren gültigen Search_Filter-Werten empfängt, THE Search_API SHALL eine Liste der Listings zurückgeben, in der jedes zurückgegebene Listing alle angegebenen Filterkriterien gleichzeitig erfüllt.
2. THE Search_API SHALL die Range-Filter mit folgenden Wertebereichen unterstützen: Preis von 0 bis 999.999.999, Zimmeranzahl von 1 bis 99, Fläche von 1 bis 100.000 Quadratmetern sowie den Ort-Filter als exakte Übereinstimmung des Ortsnamens.
3. WHEN eine Suchanfrage mehr als 50 passende Listings liefert, THE Search_API SHALL höchstens 50 Listings pro Ergebnisseite zurückgeben und einen Verweis auf die nächste Ergebnisseite bereitstellen.
4. WHEN eine Suchanfrage mit identischen Filter- und Paginierungsparametern wiederholt wird, THE Search_API SHALL die Listings in derselben deterministischen Reihenfolge zurückgeben.
5. IF eine Suchanfrage einen Search_Filter mit einem syntaktisch ungültigen Wert enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe des betroffenen Feldes zurückgeben, ohne die Suche auszuführen.
6. IF eine Suchanfrage für einen Range-Filter einen Minimalwert größer als den zugehörigen Maximalwert bei Preis oder Fläche enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe des betroffenen Feldes zurückgeben, ohne die Suche auszuführen.
7. WHEN eine Suchanfrage keine passenden Listings findet, THE Search_API SHALL den Statuscode 200 und eine leere Ergebnisliste zurückgeben.

### Requirement 2: Abruf einzelner Listing-Details über die API

**User Story:** Als AI_Agent möchte ich die vollständigen Details einer einzelnen Immobilie abrufen, damit ich einem Nutzer detaillierte Informationen bereitstellen kann.

#### Acceptance Criteria

1. WHEN die Search_API eine Anfrage für einen existierenden Listing-Bezeichner empfängt, THE Search_API SHALL innerhalb von 2 Sekunden den vollständigen Listing-Datensatz mit allen für den Listing_Typ definierten Pflichtfeldern zurückgeben.
2. IF die Search_API eine Anfrage für einen nicht existierenden Listing-Bezeichner empfängt, THEN THE Search_API SHALL den Statuscode 404 und eine maschinenlesbare Fehlerbeschreibung zurückgeben, die den fehlenden Bezeichner angibt, ohne einen Listing-Datensatz zurückzugeben.
3. IF die Search_API eine Anfrage mit einem leeren oder syntaktisch ungültigen Listing-Bezeichner empfängt, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung zurückgeben.
4. IF die Search_API den Listing-Datensatz nicht innerhalb von 2 Sekunden bereitstellen kann, THEN THE Search_API SHALL die Anfrage mit einem Fehler beantworten, der eine Zeitüberschreitung anzeigt.

### Requirement 3: AI-/Agent-freundliches API-Design

**User Story:** Als AI_Agent möchte ich eine maschinenlesbare Beschreibung der Such-API abrufen, damit ich die verfügbaren Endpunkte, Parameter und Datenmodelle automatisch erkennen und korrekt verwenden kann.

#### Acceptance Criteria

1. WHEN ein AI_Agent den Discovery-Endpunkt abruft, THE Search_API SHALL ein API_Schema in einem maschinenlesbaren Standardformat innerhalb von 2 Sekunden bereitstellen.
2. THE API_Schema SHALL alle Endpunkte, alle Search_Filter-Parameter mit ihren Datentypen, der Angabe ob Pflicht- oder optionaler Parameter und den zulässigen Wertebereichen (minimaler und maximaler Wert bzw. zulässige Enumerationswerte) sowie das Listing-Datenmodell mit allen Feldern und deren Datentypen beschreiben.
3. THE Search_API SHALL für alle Antworten strukturierte, konsistent benannte Datenfelder in einem maschinenlesbaren Format bereitstellen, deren Feldnamen und Datentypen mit dem im API_Schema beschriebenen Listing-Datenmodell übereinstimmen.
4. IF eine Anfrage fehlschlägt, THEN THE Search_API SHALL eine Fehlerantwort mit einem eindeutigen, maschinenlesbaren Fehlercode und einer menschenlesbaren Beschreibung zurückgeben, die die Ursache des Fehlers angibt.
5. IF eine Anfrage einen Search_Filter-Parameter mit einem Wert außerhalb des im API_Schema definierten zulässigen Wertebereichs enthält, THEN THE Search_API SHALL die Anfrage ablehnen und einen Fehlercode zurückgeben, der den ungültigen Parameter benennt, ohne die Anfrage zu verarbeiten.
6. THE Platform SHALL eine Developer_Documentation bereitstellen, die für jeden Endpunkt mindestens ein vollständiges Anfrage-Beispiel und ein vollständiges Antwort-Beispiel enthält.

### Requirement 4: Immobilien-Datenmodell und Listing-Management

**User Story:** Als Administrator möchte ich ein konsistentes Immobilien-Datenmodell, damit Listings aus unterschiedlichen Quellen einheitlich gespeichert und durchsucht werden können.

#### Acceptance Criteria

1. THE Listing_Store SHALL für jedes Listing die folgenden Pflichtfelder mit den angegebenen Wertebereichen speichern: eindeutiger Bezeichner (1 bis 128 Zeichen), Ort (1 bis 200 Zeichen), Preis (0,01 bis 999.999.999,99), Zimmeranzahl (0 bis 100), Fläche (1 bis 100.000 Quadratmeter), Immobilientyp aus der definierten Werteliste und Beschreibung (0 bis 5.000 Zeichen).
2. WHEN ein Connector ein Listing importiert, THE Connector_Framework SHALL für jedes Pflichtfeld sowohl dessen Vorhandensein als auch die Einhaltung des zugehörigen Wertebereichs bzw. der zugehörigen Werteliste validieren, bevor das Listing im Listing_Store gespeichert wird.
3. IF ein importiertes Listing ein Pflichtfeld nicht enthält oder einen Feldwert außerhalb des zulässigen Wertebereichs bzw. der zulässigen Werteliste enthält, THEN THE Connector_Framework SHALL das Listing abweisen, den bestehenden Datenbestand unverändert lassen und das betroffene Feld im Protokoll nennen.
4. WHEN ein Listing importiert wird, dessen eindeutiger Bezeichner bereits im Listing_Store vorhanden ist, THE Connector_Framework SHALL den bestehenden Listing-Datensatz vollständig mit den importierten Werten aktualisieren.
5. THE Listing_Store SHALL für jedes Listing die Datenquelle und den Zeitpunkt des letzten Imports speichern.

### Requirement 5: Erweiterbare Connector-Architektur für Datenimport

**User Story:** Als Administrator möchte ich neue Datenquellen über austauschbare Connectors einbinden, damit ich bestehende Datenbanken, externe APIs und Webseiten ohne Änderung des Kern-Backends integrieren kann.

#### Acceptance Criteria

1. THE Connector_Framework SHALL Connectors über eine definierte Schnittstelle mit den beobachtbaren Pflichtoperationen Initialisieren, Ausführen und Status-Melden registrieren, sodass ein neuer Connector hinzugefügt werden kann, ohne den bestehenden Kern-Backend-Code zu ändern.
2. THE Connector_Framework SHALL Connectors für die Datenquellentypen relationale Datenbank, externe API und Webseite unterstützen.
3. WHEN ein Administrator einen Connector mit einer gültigen Konfiguration aktiviert, THE Connector_Framework SHALL den Connector gemäß seiner Konfiguration ausführen.
4. IF die Konfiguration eines zu aktivierenden Connectors ungültig ist, THEN THE Connector_Framework SHALL die Ausführung des Connectors ablehnen und den Grund der Ablehnung protokollieren.
5. WHEN ein Connector ausgeführt wird, THE Connector_Framework SHALL jedes importierte Listing in das normalisierte Listing-Datenmodell überführen, bevor es im Listing_Store gespeichert wird.
6. IF ein Listing bei der Normalisierung oder Validierung einen Fehler verursacht, THEN THE Connector_Framework SHALL dieses Listing abweisen und den Grund der Abweisung protokollieren.
7. IF ein Connector_Lauf die konfigurierbare Ausführungszeitgrenze (Standardwert 300 Sekunden) überschreitet, THEN THE Connector_Framework SHALL den betroffenen Connector beenden, den Connector-Fehler protokollieren und die Ausführung der übrigen aktiven Connectors fortsetzen.
8. WHEN ein Connector_Lauf abgeschlossen ist, THE Connector_Framework SHALL die Anzahl der importierten, aktualisierten und abgewiesenen Listings protokollieren.

### Requirement 6: Rechtskonformer Webcrawler

**User Story:** Als Administrator möchte ich Immobiliendaten per Webcrawler beziehen, wobei nur rechtlich zulässige Quellen gecrawlt werden, damit die Plattform compliance-konform betrieben werden kann.

#### Acceptance Criteria

1. WHEN der Crawler_Connector eine Zielseite crawlen soll, THE Compliance_Checker SHALL vor dem ersten Abruf die robots.txt der Zielseite abrufen und auswerten.
2. IF der Abruf der robots.txt nach spätestens 10 Sekunden nicht erfolgreich abgeschlossen ist oder mit einem Fehler endet, THEN THE Crawler_Connector SHALL den Abruf der Zielseite unterlassen und den fehlgeschlagenen robots.txt-Abruf mit Grund im Crawl-Protokoll vermerken.
3. IF die robots.txt der Zielseite den Abruf eines Pfades untersagt, THEN THE Crawler_Connector SHALL diesen Pfad nicht abrufen.
4. WHERE eine Zielseite nicht auf der vom Administrator konfigurierten Erlaubnisliste steht, THE Crawler_Connector SHALL die Zielseite nicht crawlen.
5. WHEN der Crawler_Connector eine Zielseite abruft, THE Crawler_Connector SHALL die vom Administrator pro Zielseite konfigurierte maximale Abrufrate (in Anfragen pro Sekunde, Wertebereich 0,1 bis 100) einhalten und zwischen zwei aufeinanderfolgenden Anfragen an dieselbe Zielseite mindestens die sich aus der konfigurierten Abrufrate ergebende Mindestwartezeit einhalten.
6. THE Crawler_Connector SHALL für jeden Crawl_Lauf je Zielseite die abgerufene Zielseiten-Adresse, das Ergebnis der Compliance-Prüfung (zulässig oder unzulässig mit Grund) und den Zeitpunkt des Abrufs mit Datum, Uhrzeit und Zeitzone protokollieren.
7. IF der Compliance_Checker die rechtliche Zulässigkeit einer Zielseite nicht bestätigen kann, THEN THE Crawler_Connector SHALL den Abruf dieser Zielseite unterlassen und das Ergebnis der Compliance-Prüfung als unzulässig mit Grund im Crawl-Protokoll vermerken.

### Requirement 7: Immobiliensuche im Frontend

**User Story:** Als menschlicher Nutzer möchte ich im Web-Frontend nach Immobilien suchen und filtern, damit ich passende Angebote visuell durchsehen kann.

#### Acceptance Criteria

1. THE Frontend SHALL Eingabeelemente zum Setzen der folgenden Search_Filter mit den angegebenen Wertebereichen bereitstellen: Preisbereich von 0 bis 100.000.000, Zimmeranzahl von 1 bis 50, Flächenbereich von 1 bis 100.000 Quadratmetern, Immobilientyp aus einer vordefinierten Liste und Ort.
2. IF ein Nutzer eine Suche mit ungültigen oder inkonsistenten Filterwerten auslöst, THEN THE Frontend SHALL die Werte vor dem Aufruf der Search_API validieren, das betroffene Feld benennen und die eingegebenen Filterwerte erhalten.
3. WHEN ein Nutzer eine Suche mit ausschließlich gültigen Search_Filter-Werten auslöst, THE Frontend SHALL die Suchergebnisse über die Search_API abrufen und höchstens 50 Listings pro Ergebnisseite als Liste darstellen.
4. THE Frontend SHALL für jedes Listing in der Ergebnisliste Ort, Preis, Zimmeranzahl, Fläche und Immobilientyp anzeigen.
5. WHEN ein Nutzer ein Listing in der Ergebnisliste auswählt, THE Frontend SHALL die vollständigen Details des Listings anzeigen.
6. WHEN eine Suche keine passenden Listings liefert, THE Frontend SHALL eine Hinweismeldung anzeigen, dass keine Ergebnisse gefunden wurden.
7. IF die Search_API eine Fehlerantwort zurückgibt oder nicht innerhalb von 10 Sekunden antwortet, THEN THE Frontend SHALL eine menschenlesbare Fehlermeldung anzeigen und die eingegebenen Filterwerte erhalten.

### Requirement 8: Adaptierbarkeit und White-Labeling des Frontends

**User Story:** Als Administrator möchte ich Logo, Farben und Texte des Frontends über Konfiguration anpassen, damit ich die Plattform ohne Code-Änderungen an eine eigene Marke anpassen kann.

#### Acceptance Criteria

1. THE Frontend SHALL Logo, Primär- und Sekundärfarben sowie sichtbare Oberflächentexte aus der Theme_Config beziehen.
2. WHEN die Theme_Config geänderte Branding-Werte enthält, THE Frontend SHALL die geänderten Werte ohne Änderung des Anwendungs-Quellcodes innerhalb von 5 Sekunden nach dem Neuladen übernehmen.
3. WHERE die Theme_Config für einen Branding-Wert keinen Eintrag enthält, THE Frontend SHALL einen dokumentierten Standardwert verwenden.
4. IF die Theme_Config einen ungültigen Wert enthält, THEN THE Frontend SHALL den dokumentierten Standardwert für den betroffenen Branding-Wert verwenden und den Fehler protokollieren.
5. WHERE die Theme_Config sowohl gültige als auch ungültige Branding-Werte enthält, THE Frontend SHALL die gültigen Werte übernehmen und für jeden ungültigen Wert den dokumentierten Standardwert verwenden.
6. THE Platform SHALL eine Dokumentation bereitstellen, die alle über die Theme_Config konfigurierbaren Branding-Werte und ihre zulässigen Formate beschreibt.

### Requirement 9: AWS-basiertes Deployment

**User Story:** Als Administrator möchte ich die Plattform auf AWS betreiben, damit ich eine skalierbare und wartbare Infrastruktur nutzen kann.

#### Acceptance Criteria

1. WHEN ein Client eine Anfrage an den öffentlichen Endpunkt der Search_API sendet, THE Platform SHALL die Anfrage über AWS API Gateway entgegennehmen und innerhalb von 5 Sekunden eine Antwort zurückgeben.
2. THE Platform SHALL vollständig als Infrastruktur-als-Code-Definition bereitgestellt werden, sodass ein Administrator die gesamte Plattform in einem leeren AWS-Konto mit einem einzigen Bereitstellungsbefehl und ohne manuelle Konsolenschritte provisionieren kann.
3. THE Platform SHALL alle Konfigurationswerte für Umgebung und Datenquellen außerhalb des Anwendungs-Quellcodes aus einer externen Konfigurationsquelle beziehen und für jeden erforderlichen Konfigurationswert einen eindeutigen Namen und zugehörigen Wert bereitstellen.
4. IF ein erforderlicher Konfigurationswert beim Start der Platform fehlt oder leer ist, THEN THE Platform SHALL den Start abbrechen und eine maschinenlesbare Fehlerbeschreibung zurückgeben, die den Namen des fehlenden Konfigurationswerts angibt.
5. IF ein Aufruf der Search_API scheitert, weil ein nachgelagerter AWS-Dienst nicht erreichbar ist, THEN THE Search_API SHALL den Statuscode 503 und eine maschinenlesbare Fehlerbeschreibung zurückgeben, ohne dass Teilergebnisse persistiert werden.
6. IF ein nachgelagerter AWS-Dienst nicht innerhalb von 10 Sekunden antwortet, THEN THE Search_API SHALL den Aufruf abbrechen und den Statuscode 503 mit einer maschinenlesbaren Fehlerbeschreibung zurückgeben.

### Requirement 10: Dokumentation und Open-Source-Freundlichkeit

**User Story:** Als externer Mitwirkender möchte ich eine vollständige Dokumentation der Plattform, damit ich die Plattform eigenständig aufsetzen, konfigurieren und erweitern kann.

#### Acceptance Criteria

1. THE Platform SHALL eine Installationsdokumentation bereitstellen, die die Voraussetzungen sowie reproduzierbare, nummerierte Schritte zum Bereitstellen der Plattform in einem AWS-Konto beschreibt.
2. IF während der Installation ein dokumentierter Fehlerfall eintritt, THEN THE Developer_Documentation SHALL einen Behebungsschritt für diesen Fehlerfall beschreiben.
3. THE Platform SHALL eine Erweiterungsdokumentation bereitstellen, die für das Erstellen eines neuen Connectors mindestens die Connector_Framework-Schnittstelle, die Pflichtoperationen, die Registrierung und ein Beispiel beschreibt.
4. THE Platform SHALL eine von der Open Source Initiative anerkannte quelloffene Lizenz als eigenständige Lizenzdatei im Quellcode-Repository bereitstellen.
5. THE Platform SHALL die Theming-, API- und Connector-Dokumentation je einzeln im Quellcode-Repository bereitstellen.

## Non-Functional Requirements

### Requirement 11: Nicht-funktionale Qualitätsanforderungen

**User Story:** Als Administrator möchte ich, dass die Plattform adaptierbar, dokumentiert und compliance-konform betrieben wird, damit sie als Open-Source-Projekt nachhaltig nutzbar ist.

#### Acceptance Criteria

1. THE Platform SHALL alle umgebungsspezifischen und datenquellenspezifischen Konfigurationswerte (Datenquellen-Endpunkte, Zugangsdaten, Zeitplan-Intervalle, Umgebungsbezeichner) ausschließlich aus einer externen Konfigurationsquelle (Umgebungsvariablen oder Konfigurationsdatei) beziehen und keinen dieser Werte im Quellcode fest kodieren.
2. IF beim Start der Platform ein als erforderlich gekennzeichneter Konfigurationswert fehlt oder ungültig ist, THEN THE Platform SHALL den Start abbrechen und einen Fehler ausgeben, der den Namen des betroffenen Konfigurationswerts benennt.
3. WHEN eine Suchanfrage ohne Filter an die Search_API gestellt wird, THE Search_API SHALL die erste Ergebnisseite mit höchstens 20 Listings innerhalb von 2 Sekunden zurückgeben.
4. IF die Search_API die erste Ergebnisseite nicht innerhalb von 2 Sekunden bereitstellen kann, THEN THE Search_API SHALL die Anfrage mit einem Fehler beantworten, der eine Zeitüberschreitung anzeigt.
5. THE Platform SHALL jeden Connector_Lauf und jeden Crawl_Lauf mit Startzeitpunkt, Endzeitpunkt, Quellenbezeichner und Ergebnisstatus (Erfolg oder Fehler) protokollieren, sodass die Herkunftsquelle jedes Listings eindeutig einem Lauf zugeordnet werden kann.
6. THE Crawler_Connector SHALL ausschließlich Zielseiten abrufen, deren rechtliche Zulässigkeit durch den Compliance_Checker vor dem Abruf bestätigt wurde.
7. IF der Compliance_Checker die rechtliche Zulässigkeit einer Zielseite verweigert oder nicht erreichbar ist, THEN THE Crawler_Connector SHALL den Abruf dieser Zielseite unterlassen und das Ausbleiben des Abrufs mit Quellenbezeichner und Grund protokollieren.
