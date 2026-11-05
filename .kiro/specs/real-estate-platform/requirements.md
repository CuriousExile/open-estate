# Requirements Document

## Introduction

Dieses Dokument beschreibt die Anforderungen an eine quelloffene Immobilien-Plattform. Die Plattform besteht aus einem Web-Frontend für menschliche Nutzer und einem Backend mit einer AI-/Agent-freundlichen Such-API, über die AI-Agents und AI-Tools strukturiert nach Immobilien suchen können. Zusätzlich stellt die Plattform einen MCP-Server bereit, der die Such- und Detailfunktionen als Agent-Tools anbietet.

Die Plattform wird auf AWS betrieben und stellt ihre APIs über AWS API Gateway bereit. Ein zentrales Gestaltungsprinzip ist maximale Adaptierbarkeit: Da die Plattform Open Source ist, müssen Branding, Theming, Texte, Sprachen, die Immobilien-Taxonomie und zulässige 3D-Tour-Anbieter ohne Code-Änderungen über Konfiguration anpassbar sein (White-Labeling). Die Datenbeschaffung erfolgt über eine erweiterbare Connector-Architektur, die bestehende Datenbanken, externe APIs und einen rechtskonformen Webcrawler einbinden kann. Die Verarbeitung personenbezogener Daten erfolgt DSGVO-konform.

Das Listing-Datenmodell (Requirement 4) ist die einzige maßgebliche Definition aller Feld-Wertebereiche; Search_API, MCP_Server und Frontend referenzieren diese Definition.

Dieses Dokument konzentriert sich auf das *Was* (fachliche Anforderungen). Technische Umsetzungsdetails werden im Design-Dokument behandelt.

## Glossary

- **Platform**: Das Gesamtsystem bestehend aus Frontend, Backend-API, MCP_Server und Datenbeschaffungsschicht.
- **Search_API**: Die über AWS API Gateway bereitgestellte Programmierschnittstelle zum Suchen und Abrufen von Immobilien-Listings.
- **MCP_Server**: Die von der Platform bereitgestellte Schnittstelle nach dem Model Context Protocol, die die Such- und Detailfunktionen der Search_API als Agent_Tools anbietet und dieselbe Domänenlogik wie die Search_API verwendet.
- **Agent_Tool**: Eine vom MCP_Server angebotene, von einem AI_Agent aufrufbare Funktion (search_listings, get_listing, list_property_types).
- **Frontend**: Die browserbasierte Benutzeroberfläche (bevorzugt Angular) für menschliche Nutzer.
- **AI_Agent**: Ein automatisierter Software-Client (AI-Agent oder AI-Tool), der die Search_API oder den MCP_Server programmatisch konsumiert.
- **Client**: Ein Aufrufer der Search_API oder des MCP_Server, identifiziert über seinen API_Key oder, falls kein API_Key verwendet wird, über seine Quell-IP-Adresse.
- **API_Key**: Ein vom Administrator ausgegebener geheimer Zugangsschlüssel, mit dem sich ein Client gegenüber der Search_API und dem MCP_Server ausweist.
- **Rate_Limit**: Die vom Administrator konfigurierbare maximale Anzahl von Anfragen pro Client innerhalb eines Zeitfensters.
- **Listing**: Ein Datensatz, der eine einzelne Immobilie mit ihren Attributen gemäß Listing-Datenmodell (Requirement 4) repräsentiert.
- **Listing_Store**: Die persistente Datenhaltung, in der normalisierte Listings gespeichert werden.
- **Angebotsart**: Die Vermarktungsform eines Angebots mit den sprachneutralen Codes `SALE` (Kauf) und `RENT` (Miete).
- **Angebot**: Ein Vermarktungsangebot eines Listings mit genau einer Angebotsart, einem Preis und einer Währung; bei Angebotsart `RENT` zusätzlich optional Nebenkosten und Warmmiete. Ein Listing hat ein oder zwei Angebote, höchstens eines je Angebotsart, und kann somit gleichzeitig zum Kauf und zur Miete angeboten werden.
- **Preis**: Der maßgebliche Betrag eines Angebots; bei einem Angebot der Angebotsart `SALE` der Kaufpreis, bei einem Angebot der Angebotsart `RENT` die monatliche Kaltmiete.
- **Kaltmiete**: Die monatliche Miete ohne Nebenkosten; Pflichtangabe bei einem Angebot der Angebotsart `RENT`.
- **Nebenkosten**: Die optionalen monatlichen Betriebskosten eines Angebots der Angebotsart `RENT` zusätzlich zur Kaltmiete.
- **Warmmiete**: Die optionale monatliche Gesamtmiete aus Kaltmiete und Nebenkosten.
- **Währung**: Der Währungscode eines Preises nach ISO 4217 (Alpha-3, z. B. EUR).
- **Standardwährung**: Die vom Administrator konfigurierte Währung, die die Search_API bei Preisfiltern ohne explizite Währungsangabe verwendet.
- **Immobilien_Taxonomie**: Die konfigurierbare, zweistufige Klassifikation aus Immobiliengruppen und zugeordneten Listing_Typen.
- **Immobiliengruppe**: Die obere Ebene der Immobilien_Taxonomie mit einem sprachneutralen Code (z. B. Wohnung, Haus, Grundstück, Gewerbe).
- **Listing_Typ**: Die konkrete Kategorie einer Immobilie mit einem sprachneutralen Code, die genau einer Immobiliengruppe der Immobilien_Taxonomie zugeordnet ist (z. B. Penthouse in der Immobiliengruppe Wohnung).
- **Locale**: Ein Sprachkennzeichen nach BCP 47 (z. B. `de`, `en`, `de-AT`).
- **Standardsprache**: Die vom Administrator konfigurierte Locale, die bei fehlender Übersetzung oder fehlender Sprachwahl verwendet wird.
- **Übersetzungsdatei**: Eine Konfigurationsdatei je Locale, die lokalisierte UI-Texte sowie lokalisierte Bezeichnungen für sprachneutrale Codes (Angebotsart, Immobiliengruppe, Listing_Typ) enthält.
- **Übersetzungskonfiguration**: Die Gesamtheit aller Übersetzungsdateien sowie die Liste der aktivierten Locales und die Standardsprache.
- **Sprachfassung**: Die Ausprägung von Titel und Beschreibung eines Listings in einer bestimmten Locale.
- **Originalsprache**: Die Locale der Sprachfassung, in der ein Listing von der Datenquelle geliefert wurde.
- **Medium**: Ein einem Listing zugeordnetes Bild, referenziert über eine URL.
- **3D_Tour**: Eine einem Listing zugeordnete virtuelle 3D-Hausführung, referenziert über die Tour-URL eines Tour_Anbieters.
- **Tour_Anbieter**: Ein externer Dienst, der 3D_Touren bereitstellt (z. B. Matterport).
- **Tour_Erlaubnisliste**: Die vom Administrator konfigurierte Liste zulässiger Tour_Anbieter mit den jeweils zulässigen Hostnamen für Tour-URLs.
- **Connector**: Eine austauschbare Komponente, die Immobiliendaten aus einer externen Quelle (Datenbank, API oder Webseite) in das normalisierte Listing-Format importiert.
- **Connector_Framework**: Die Backend-Komponente, die Connectors registriert, konfiguriert und ausführt.
- **Connector_Lauf**: Eine einzelne Ausführung eines Connectors durch das Connector_Framework von Start bis Abschluss.
- **Crawler_Connector**: Ein spezieller Connector, der Immobiliendaten durch Crawlen von Webseiten bezieht.
- **Crawl_Lauf**: Eine einzelne Ausführung des Crawler_Connector über eine oder mehrere Zielseiten von Start bis Abschluss.
- **Compliance_Checker**: Die Komponente, die vor einem Crawl die rechtliche Zulässigkeit einer Zielseite anhand der Erlaubnisliste, der dokumentierten Rechtsgrundlage und der robots.txt prüft.
- **Zielseite**: Eine vom Crawler_Connector abzurufende Webseite, die als Datenquelle für Immobiliendaten dient.
- **Erlaubnisliste**: Die vom Administrator konfigurierte Liste der Zielseiten, die gecrawlt werden dürfen, mit einer Rechtsgrundlage als Pflichtangabe je Eintrag.
- **Rechtsgrundlage**: Die vom Administrator je Zielseite dokumentierte rechtliche Begründung für das Crawlen (z. B. Lizenzvertrag, schriftliche Zustimmung des Betreibers); robots.txt allein stellt keine Rechtsgrundlage dar.
- **Personenbezogenes_Feld**: Ein Datenfeld einer Datenquelle, das Daten zu einer identifizierten oder identifizierbaren natürlichen Person enthält (z. B. Name, Telefonnummer oder E-Mail-Adresse eines Maklers oder Anbieters).
- **PII_Feld_Erlaubnisliste**: Die vom Administrator konfigurierte Liste der Personenbezogenen_Felder, die im Listing_Store gespeichert werden dürfen.
- **Löschanfrage**: Ein Auftrag eines Administrators, Listings anhand eines Listing-Bezeichners oder einer Datenquelle dauerhaft aus dem Listing_Store zu entfernen.
- **Löschsperrliste**: Die Liste der per Löschanfrage entfernten Listing-Bezeichner, deren erneuter Import abgewiesen wird.
- **Theme_Config**: Die Konfigurationsquelle, die Branding-Werte (Logo, Farben, Texte je Locale) für das Frontend bereitstellt.
- **API_Schema**: Die maschinenlesbare Beschreibung der Search_API (z. B. OpenAPI-Dokument) inklusive Endpunkten, Parametern, Datenmodellen, Immobilien_Taxonomie und sprachneutralen Codes.
- **Seitengröße**: Die Anzahl der Listings pro Ergebnisseite; Standardwert 20, Wertebereich 1 bis 50.
- **Referenzlast**: Die für Performance-Ziele definierte Last von 50 Anfragen pro Sekunde über 10 Minuten bei einem Datenbestand von 100.000 Listings.
- **Developer_Documentation**: Die für Entwickler und Mitwirkende bereitgestellte Dokumentation (Installation, Erweiterung, Theming, Übersetzung, API, MCP, Connectors) im Quellcode-Repository.
- **Administrator**: Eine Person, die die Administrator-Rolle innehat und die Platform betreibt, konfiguriert und Connectors, Theming, Übersetzungen und Erlaubnislisten verwaltet.
- **Administrator-Rolle**: Die Berechtigung, administrative Operationen wie das Auslösen von Löschanfragen und das Ändern von Konfigurationen auszuführen.
- **Search_Filter**: Die Menge strukturierter Suchkriterien: Angebotsart, Preisbereich, Währung, Zimmeranzahlbereich, Flächenbereich, Ort, Postleitzahl, Immobiliengruppe, Listing_Typ(en) und Vorhandensein einer 3D_Tour.

## Requirements

### Requirement 1: Strukturierte Immobiliensuche über die API

**User Story:** Als AI_Agent möchte ich über eine strukturierte API nach Immobilien mit definierten Filterkriterien suchen, damit ich passende Listings programmatisch abrufen kann.

#### Acceptance Criteria

1. WHEN die Search_API eine Suchanfrage mit einem oder mehreren gültigen Search_Filter-Werten empfängt, THE Search_API SHALL eine Liste der Listings zurückgeben, in der jedes zurückgegebene Listing alle angegebenen Filterkriterien gleichzeitig erfüllt.
2. THE Search_API SHALL die Range-Filter Preis, Zimmeranzahl und Fläche mit jeweils optionalem Minimal- und Maximalwert unterstützen, deren zulässige Wertebereiche und Datentypen den Feldern des Listing-Datenmodells gemäß Requirement 4 entsprechen.
3. WHEN eine Suchanfrage einen Ort-Filter enthält, THE Search_API SHALL ausschließlich Listings zurückgeben, deren Ort unter Nichtbeachtung von Groß- und Kleinschreibung exakt mit dem angegebenen Ortsnamen übereinstimmt.
4. WHEN eine Suchanfrage einen Postleitzahl-Filter enthält, THE Search_API SHALL ausschließlich Listings zurückgeben, deren Postleitzahl exakt mit der angegebenen Postleitzahl übereinstimmt.
5. WHEN eine Suchanfrage eine Seitengröße zwischen 1 und 50 angibt, THE Search_API SHALL höchstens die angegebene Anzahl Listings pro Ergebnisseite zurückgeben.
6. WHEN eine Suchanfrage keine Seitengröße angibt, THE Search_API SHALL höchstens 20 Listings pro Ergebnisseite zurückgeben.
7. WHEN eine Suchanfrage mehr passende Listings liefert, als auf eine Ergebnisseite passen, THE Search_API SHALL einen Verweis auf die nächste Ergebnisseite bereitstellen.
8. WHEN eine Suchanfrage mit identischen Filter- und Paginierungsparametern wiederholt wird, THE Search_API SHALL die Listings in derselben deterministischen Reihenfolge zurückgeben.
9. IF eine Suchanfrage einen Search_Filter mit einem syntaktisch ungültigen Wert enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe des betroffenen Feldes zurückgeben, ohne die Suche auszuführen.
10. IF eine Suchanfrage für einen Range-Filter (Preis, Zimmeranzahl oder Fläche) einen Minimalwert größer als den zugehörigen Maximalwert enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe des betroffenen Feldes zurückgeben, ohne die Suche auszuführen.
11. IF eine Suchanfrage eine Seitengröße außerhalb des Wertebereichs 1 bis 50 enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe des Feldes Seitengröße zurückgeben, ohne die Suche auszuführen.
12. WHEN eine Suchanfrage keine passenden Listings findet, THE Search_API SHALL den Statuscode 200 und eine leere Ergebnisliste zurückgeben.

### Requirement 2: Abruf einzelner Listing-Details über die API

**User Story:** Als AI_Agent möchte ich die vollständigen Details einer einzelnen Immobilie abrufen, damit ich einem Nutzer detaillierte Informationen bereitstellen kann.

#### Acceptance Criteria

1. WHEN die Search_API eine Anfrage für einen existierenden Listing-Bezeichner empfängt, THE Search_API SHALL den vollständigen Listing-Datensatz mit allen Pflichtfeldern des Listing-Datenmodells gemäß Requirement 4 einschließlich aller Angebote des Listings sowie allen vorhandenen optionalen Feldern zurückgeben.
2. IF die Search_API eine Anfrage für einen nicht existierenden Listing-Bezeichner empfängt, THEN THE Search_API SHALL den Statuscode 404 und eine maschinenlesbare Fehlerbeschreibung zurückgeben, die den fehlenden Bezeichner angibt, ohne einen Listing-Datensatz zurückzugeben.
3. IF die Search_API eine Anfrage mit einem leeren oder syntaktisch ungültigen Listing-Bezeichner empfängt, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung zurückgeben.
4. WHILE die Search_API unter Referenzlast betrieben wird, THE Search_API SHALL Detailanfragen für existierende Listing-Bezeichner mit einer p95-Latenz von höchstens 2 Sekunden beantworten.

### Requirement 3: AI-/Agent-freundliches API-Design

**User Story:** Als AI_Agent möchte ich eine maschinenlesbare Beschreibung der Such-API abrufen, damit ich die verfügbaren Endpunkte, Parameter und Datenmodelle automatisch erkennen und korrekt verwenden kann.

#### Acceptance Criteria

1. WHEN ein AI_Agent den Discovery-Endpunkt abruft, THE Search_API SHALL ein API_Schema in einem maschinenlesbaren Standardformat innerhalb von 2 Sekunden bereitstellen.
2. THE API_Schema SHALL alle Endpunkte, alle Search_Filter-Parameter mit ihren Datentypen, der Angabe ob Pflicht- oder optionaler Parameter und den zulässigen Wertebereichen (minimaler und maximaler Wert bzw. zulässige Enumerationswerte) sowie das Listing-Datenmodell mit allen Feldern und deren Datentypen beschreiben.
3. THE Search_API SHALL für alle Antworten strukturierte, konsistent benannte Datenfelder in einem maschinenlesbaren Format bereitstellen, deren Feldnamen und Datentypen mit dem im API_Schema beschriebenen Listing-Datenmodell übereinstimmen.
4. IF eine Anfrage fehlschlägt, THEN THE Search_API SHALL eine Fehlerantwort mit einem eindeutigen, maschinenlesbaren Fehlercode und einer menschenlesbaren Beschreibung zurückgeben, die die Ursache des Fehlers angibt.
5. IF eine Anfrage einen Search_Filter-Parameter mit einem Wert außerhalb des im API_Schema definierten zulässigen Wertebereichs enthält, THEN THE Search_API SHALL die Anfrage ablehnen und einen Fehlercode zurückgeben, der den ungültigen Parameter benennt, ohne die Anfrage zu verarbeiten.
6. THE Platform SHALL eine Developer_Documentation bereitstellen, die für jeden Endpunkt mindestens ein vollständiges Anfrage-Beispiel und ein vollständiges Antwort-Beispiel enthält.
7. THE API_Schema SHALL die aktuell konfigurierte Immobilien_Taxonomie, die Codes der Angebotsart und die Liste der aktivierten Locales als zulässige Enumerationswerte enthalten.
8. THE Search_API SHALL Angebotsart, Immobiliengruppe und Listing_Typ in Anfragen und Antworten ausschließlich als sprachneutrale Codes verwenden.

### Requirement 4: Immobilien-Datenmodell und Listing-Management

**User Story:** Als Administrator möchte ich ein konsistentes Immobilien-Datenmodell, damit Listings aus unterschiedlichen Quellen einheitlich gespeichert und durchsucht werden können.

#### Acceptance Criteria

1. THE Listing_Store SHALL für jedes Listing die folgenden Pflichtfelder speichern: eindeutiger Bezeichner (1 bis 128 Zeichen), Titel (1 bis 300 Zeichen je Sprachfassung), Beschreibung (0 bis 5.000 Zeichen je Sprachfassung), Originalsprache (Locale), ein bis zwei Angebote gemäß Requirement 12, Listing_Typ (Code aus der Immobilien_Taxonomie) und Quell-URL (absolute URL mit Schema http oder https, 1 bis 2.048 Zeichen).
2. THE Listing_Store SHALL für jedes Listing eine Adresse mit den Pflichtfeldern Ort (1 bis 200 Zeichen), Postleitzahl (1 bis 10 Zeichen) und Land (Code nach ISO 3166-1 Alpha-2) sowie dem optionalen Feld Straße mit Hausnummer (1 bis 200 Zeichen) speichern.
3. THE Listing_Store SHALL für jedes Angebot eines Listings den Preis als Dezimalzahl mit höchstens zwei Nachkommastellen im Wertebereich 0,01 bis 999.999.999,99 und die zugehörige Währung als Code nach ISO 4217 Alpha-3 speichern.
4. THE Listing_Store SHALL für jedes Listing die Zimmeranzahl als Dezimalzahl im Wertebereich 0 bis 99,5 in Schritten von 0,5 speichern.
5. THE Listing_Store SHALL für jedes Listing die Fläche als Dezimalzahl mit höchstens zwei Nachkommastellen im Wertebereich 1 bis 100.000 Quadratmetern speichern.
6. WHERE ein Listing Geokoordinaten enthält, THE Listing_Store SHALL Breitengrad (Dezimalzahl von -90 bis 90) und Längengrad (Dezimalzahl von -180 bis 180) gemeinsam speichern.
7. THE Platform SHALL in Search_API, MCP_Server und Frontend für Search_Filter und Eingabevalidierung ausschließlich die in den Kriterien 4.1 bis 4.6 definierten Wertebereiche und Datentypen verwenden.
8. WHEN ein Connector ein Listing importiert, THE Connector_Framework SHALL für jedes Pflichtfeld sowohl dessen Vorhandensein als auch die Einhaltung des zugehörigen Wertebereichs bzw. der zugehörigen Werteliste validieren, bevor das Listing im Listing_Store gespeichert wird.
9. IF ein importiertes Listing ein Pflichtfeld nicht enthält oder einen Feldwert außerhalb des zulässigen Wertebereichs bzw. der zulässigen Werteliste enthält, THEN THE Connector_Framework SHALL das Listing abweisen, den bestehenden Datenbestand unverändert lassen und das betroffene Feld im Protokoll nennen.
10. IF ein importiertes Listing nur einen der beiden Werte Breitengrad und Längengrad enthält, THEN THE Connector_Framework SHALL das Listing abweisen und das fehlende Koordinatenfeld im Protokoll nennen.
11. WHEN ein Listing importiert wird, dessen eindeutiger Bezeichner bereits im Listing_Store vorhanden ist, THE Connector_Framework SHALL den bestehenden Listing-Datensatz vollständig mit den importierten Werten aktualisieren.
12. THE Listing_Store SHALL für jedes Listing die Datenquelle und den Zeitpunkt des letzten Imports speichern.

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
8. THE Compliance_Checker SHALL die Zulässigkeit einer Zielseite nur dann bestätigen, wenn die Zielseite auf der Erlaubnisliste steht, der Erlaubnislisten-Eintrag eine nicht leere Rechtsgrundlage enthält und die robots.txt den Abruf des Pfades erlaubt.
9. IF ein Eintrag der Erlaubnisliste keine oder eine leere Rechtsgrundlage enthält, THEN THE Compliance_Checker SHALL die Zielseite als unzulässig mit dem Grund „fehlende Rechtsgrundlage" bewerten.

### Requirement 7: Immobiliensuche im Frontend

**User Story:** Als menschlicher Nutzer möchte ich im Web-Frontend nach Immobilien suchen und filtern, damit ich passende Angebote visuell durchsehen kann.

#### Acceptance Criteria

1. THE Frontend SHALL Eingabeelemente zum Setzen aller Search_Filter bereitstellen, deren zulässige Wertebereiche dem Listing-Datenmodell gemäß Requirement 4 entsprechen: Angebotsart, Preisbereich, Zimmeranzahlbereich (in Schritten von 0,5), Flächenbereich, Ort, Postleitzahl, Immobiliengruppe oder Listing_Typ(en) aus der Immobilien_Taxonomie sowie Vorhandensein einer 3D_Tour.
2. IF ein Nutzer eine Suche mit ungültigen oder inkonsistenten Filterwerten auslöst, THEN THE Frontend SHALL die Werte vor dem Aufruf der Search_API validieren, das betroffene Feld benennen und die eingegebenen Filterwerte erhalten.
3. WHEN ein Nutzer eine Suche mit ausschließlich gültigen Search_Filter-Werten auslöst, THE Frontend SHALL die Suchergebnisse über die Search_API abrufen und mit einer Seitengröße von 20 Listings pro Ergebnisseite als Liste darstellen.
4. THE Frontend SHALL für jedes Listing in der Ergebnisliste Titel, die gefilterte Angebotsart, Ort, den Preis des Angebots der gefilterten Angebotsart mit Währung (Kaufpreis bei `SALE`, Kaltmiete bei `RENT`), Zimmeranzahl, Fläche und Listing_Typ anzeigen.
5. WHEN ein Nutzer ein Listing in der Ergebnisliste auswählt, THE Frontend SHALL die vollständigen Details des Listings anzeigen.
6. WHEN eine Suche keine passenden Listings liefert, THE Frontend SHALL eine Hinweismeldung anzeigen, dass keine Ergebnisse gefunden wurden.
7. IF die Search_API eine Fehlerantwort zurückgibt oder nicht innerhalb von 10 Sekunden antwortet, THEN THE Frontend SHALL eine menschenlesbare Fehlermeldung anzeigen und die eingegebenen Filterwerte erhalten.

### Requirement 8: Adaptierbarkeit und White-Labeling des Frontends

**User Story:** Als Administrator möchte ich Logo, Farben und Texte des Frontends über Konfiguration anpassen, damit ich die Plattform ohne Code-Änderungen an eine eigene Marke anpassen kann.

#### Acceptance Criteria

1. THE Frontend SHALL Logo, Primär- und Sekundärfarben sowie sichtbare Branding-Texte je Locale aus der Theme_Config beziehen.
2. WHEN die Theme_Config geänderte Branding-Werte enthält, THE Frontend SHALL die geänderten Werte ohne Änderung des Anwendungs-Quellcodes innerhalb von 5 Sekunden nach dem Neuladen übernehmen.
3. WHERE die Theme_Config für einen Branding-Wert keinen Eintrag enthält, THE Frontend SHALL einen dokumentierten Standardwert verwenden.
4. IF die Theme_Config einen ungültigen Wert enthält, THEN THE Frontend SHALL den dokumentierten Standardwert für den betroffenen Branding-Wert verwenden und den Fehler protokollieren.
5. WHERE die Theme_Config sowohl gültige als auch ungültige Branding-Werte enthält, THE Frontend SHALL die gültigen Werte übernehmen und für jeden ungültigen Wert den dokumentierten Standardwert verwenden.
6. THE Platform SHALL eine Dokumentation bereitstellen, die alle über die Theme_Config konfigurierbaren Branding-Werte und ihre zulässigen Formate beschreibt.
7. WHERE die Theme_Config für einen Branding-Text keinen Eintrag in der aktiven Locale enthält, THE Frontend SHALL den Branding-Text der Standardsprache verwenden.

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
6. THE Developer_Documentation SHALL das Hinzufügen einer neuen Locale, das Erweitern der Immobilien_Taxonomie, das Ergänzen eines Tour_Anbieters und die Anbindung eines AI_Agent an den MCP_Server jeweils mit einem Konfigurationsbeispiel beschreiben.

## Non-Functional Requirements

### Requirement 11: Nicht-funktionale Qualitätsanforderungen

**User Story:** Als Administrator möchte ich, dass die Plattform adaptierbar, dokumentiert und compliance-konform betrieben wird, damit sie als Open-Source-Projekt nachhaltig nutzbar ist.

#### Acceptance Criteria

1. THE Platform SHALL alle umgebungsspezifischen und datenquellenspezifischen Konfigurationswerte (Datenquellen-Endpunkte, Zugangsdaten, Zeitplan-Intervalle, Umgebungsbezeichner) ausschließlich aus einer externen Konfigurationsquelle (Umgebungsvariablen oder Konfigurationsdatei) beziehen und keinen dieser Werte im Quellcode fest kodieren.
2. IF beim Start der Platform ein als erforderlich gekennzeichneter Konfigurationswert fehlt oder ungültig ist, THEN THE Platform SHALL den Start abbrechen und einen Fehler ausgeben, der den Namen des betroffenen Konfigurationswerts benennt.
3. WHILE die Search_API unter Referenzlast betrieben wird, THE Search_API SHALL Suchanfragen mit der Standard-Seitengröße von 20 Listings mit einer p95-Latenz von höchstens 2 Sekunden beantworten.
4. THE Platform SHALL die Latenz jeder Such- und Detailanfrage der Search_API und des MCP_Server erfassen, sodass die p95-Latenz je Endpunkt für ein beliebiges Zeitfenster von mindestens 10 Minuten ermittelt werden kann.
5. THE Platform SHALL jeden Connector_Lauf und jeden Crawl_Lauf mit Startzeitpunkt, Endzeitpunkt, Quellenbezeichner und Ergebnisstatus (Erfolg oder Fehler) protokollieren, sodass die Herkunftsquelle jedes Listings eindeutig einem Lauf zugeordnet werden kann.
6. THE Crawler_Connector SHALL ausschließlich Zielseiten abrufen, deren rechtliche Zulässigkeit durch den Compliance_Checker vor dem Abruf bestätigt wurde.
7. IF der Compliance_Checker die rechtliche Zulässigkeit einer Zielseite verweigert oder nicht erreichbar ist, THEN THE Crawler_Connector SHALL den Abruf dieser Zielseite unterlassen und das Ausbleiben des Abrufs mit Quellenbezeichner und Grund protokollieren.

## Erweiterte funktionale Anforderungen

### Requirement 12: Angebotsart Kauf und Miete

**User Story:** Als Nutzer oder AI_Agent möchte ich zwischen Kauf- und Mietangeboten unterscheiden und gezielt danach filtern, damit Preise korrekt verglichen werden.

#### Acceptance Criteria

1. THE Listing_Store SHALL für jedes Listing mindestens ein und höchstens zwei Angebote speichern, wobei je Angebotsart höchstens ein Angebot vorkommt.
2. WHERE ein Listing ein Angebot der Angebotsart `SALE` hat, THE Listing_Store SHALL für dieses Angebot den Kaufpreis als Preis in Form einer Dezimalzahl mit höchstens zwei Nachkommastellen im Wertebereich 0,01 bis 999.999.999,99 zusammen mit der Währung des Angebots speichern.
3. WHERE ein Listing ein Angebot der Angebotsart `RENT` hat, THE Listing_Store SHALL für dieses Angebot die monatliche Kaltmiete als Preis sowie optional Nebenkosten und Warmmiete als Dezimalzahlen mit höchstens zwei Nachkommastellen im Wertebereich 0,01 bis 999.999.999,99 speichern, wobei Kaltmiete, Nebenkosten und Warmmiete innerhalb des Angebots dieselbe Währung haben.
4. IF ein Angebot der Angebotsart `RENT` eines importierten Listings eine Warmmiete enthält, die kleiner als die Kaltmiete dieses Angebots ist, THEN THE Connector_Framework SHALL das Listing abweisen, das Feld Warmmiete im Protokoll nennen und eine bereits im Listing_Store vorhandene Version des Listings unverändert lassen.
5. IF ein Angebot der Angebotsart `SALE` eines importierten Listings Nebenkosten oder Warmmiete enthält, THEN THE Connector_Framework SHALL das Listing abweisen, jedes betroffene Feld im Protokoll nennen und eine bereits im Listing_Store vorhandene Version des Listings unverändert lassen.
6. WHEN eine Suchanfrage einen Angebotsart-Filter mit dem Wert `SALE` oder `RENT` enthält, THE Search_API SHALL ausschließlich Listings zurückgeben, die ein Angebot der angegebenen Angebotsart haben, wobei ein Listing mit Angeboten beider Angebotsarten in Suchen nach `SALE` und nach `RENT` enthalten ist.
7. WHEN eine Suchanfrage einen Preisfilter und eine Angebotsart enthält, THE Search_API SHALL den Preisfilter mit inklusivem Mindest- und Höchstwert auf den Preis des Angebots der angegebenen Angebotsart anwenden (Kaufpreis bei `SALE`, Kaltmiete bei `RENT`).
8. IF eine Suchanfrage einen Preisfilter ohne Angebotsart-Filter enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe des Feldes Angebotsart zurückgeben, ohne die Suche auszuführen.
9. WHEN eine Suchanfrage einen Preisfilter enthält, THE Search_API SHALL ausschließlich Listings berücksichtigen, deren Angebot der angegebenen Angebotsart eine Währung hat, die der in der Anfrage angegebenen Währung oder, ohne Währungsangabe, der Standardwährung entspricht.
10. THE Frontend SHALL die Angebotsart in der Suche als Pflichtauswahl mit genau den Optionen `SALE` und `RENT` und der Vorauswahl `SALE` bereitstellen.
11. IF ein Angebot eines importierten Listings keine Angebotsart oder einen anderen Angebotsart-Code als `SALE` oder `RENT` enthält, THEN THE Connector_Framework SHALL das Listing abweisen, das Feld Angebotsart des betroffenen Angebots im Protokoll nennen und eine bereits im Listing_Store vorhandene Version des Listings unverändert lassen.
12. IF eine Suchanfrage einen Angebotsart-Filter mit einem anderen Wert als `SALE` oder `RENT` enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe des Feldes Angebotsart zurückgeben, ohne die Suche auszuführen.
13. WHEN ein Nutzer die Detailansicht eines Listings öffnet, THE Frontend SHALL alle Angebote des Listings mit Angebotsart, Preis und Währung anzeigen und beim Angebot der Angebotsart `RENT` die Kaltmiete als Preis sowie Nebenkosten und Warmmiete jeweils dann anzeigen, wenn der Wert im Angebot gespeichert ist.
14. IF ein importiertes Listing kein Angebot, mehr als zwei Angebote oder zwei Angebote derselben Angebotsart enthält, THEN THE Connector_Framework SHALL das Listing abweisen, das Feld Angebote im Protokoll nennen und eine bereits im Listing_Store vorhandene Version des Listings unverändert lassen.

### Requirement 13: Mehrsprachigkeit des Frontends

**User Story:** Als Nutzer möchte ich das Frontend in meiner Sprache verwenden, und als Administrator möchte ich neue Sprachen ohne Code-Änderung ergänzen, damit die Plattform international einsetzbar ist.

#### Acceptance Criteria

1. THE Frontend SHALL alle UI-Texte sowie die lokalisierten Bezeichnungen für Angebotsart, Immobiliengruppe und Listing_Typ aus der Übersetzungsdatei der aktiven Locale beziehen.
2. THE Frontend SHALL keinen für Nutzer sichtbaren Text enthalten, der nicht über einen Übersetzungsschlüssel aufgelöst wird.
3. WHEN ein Administrator eine Übersetzungsdatei für eine neue Locale hinzufügt und die Locale in der Übersetzungskonfiguration aktiviert, THE Frontend SHALL die neue Locale beim nächsten vollständigen Laden des Frontends in der Sprachauswahl anbieten, ohne dass der Anwendungs-Quellcode geändert oder neu gebaut wird.
4. THE Frontend SHALL ein Bedienelement zur Sprachauswahl bereitstellen, das genau die in der Übersetzungskonfiguration aktivierten Locales, für die eine lesbare Übersetzungsdatei vorliegt, mit ihrer Bezeichnung auflistet und die aktive Locale als ausgewählt kennzeichnet.
5. WHEN ein Nutzer eine Locale in der Sprachauswahl wählt, THE Frontend SHALL innerhalb von 1 Sekunde alle sichtbaren UI-Texte in der gewählten Locale anzeigen, ohne die Seite vollständig neu zu laden und ohne bereits eingegebene Such- und Filterwerte zu verwerfen.
6. WHEN ein Nutzer das Frontend ohne gespeicherte Sprachauswahl aufruft, THE Frontend SHALL die erste Sprache aus der Sprachpräferenzliste des Browsers (in deren Reihenfolge) verwenden, die exakt oder über ihre Hauptsprache (z. B. „de-AT“ → „de“) einer aktivierten Locale entspricht, und die Standardsprache verwenden, falls keine Browser-Sprache einer aktivierten Locale entspricht.
7. IF die Übersetzungsdatei der aktiven Locale für einen Text keinen Eintrag enthält, THEN THE Frontend SHALL den Text aus der Übersetzungsdatei der Standardsprache anzeigen.
8. IF weder die aktive Locale noch die Standardsprache einen Eintrag für einen Text enthält, THEN THE Frontend SHALL den Übersetzungsschlüssel bzw. sprachneutralen Code anzeigen und den fehlenden Eintrag mit Locale und Schlüssel protokollieren.
9. IF die Übersetzungskonfiguration für die konfigurierte Standardsprache keine Übersetzungsdatei enthält oder diese nicht lesbar bzw. syntaktisch ungültig ist, THEN THE Platform SHALL den Start abbrechen und einen Fehler ausgeben, der die betroffene Standardsprache benennt.
10. WHILE eine Locale aktiv ist, THE Frontend SHALL bei jedem Aufruf der Search_API die aktive Locale als gewünschte Sprache übermitteln.
11. WHEN ein Nutzer eine Locale in der Sprachauswahl wählt, THE Frontend SHALL die gewählte Locale im Browser speichern und bei späteren Aufrufen im selben Browser verwenden, bis der Nutzer eine andere Locale wählt, die Browserdaten gelöscht werden oder die gespeicherte Locale nicht mehr aktiviert ist, wobei im letzten Fall die Locale gemäß Kriterium 6 bestimmt wird.
12. IF die Übersetzungsdatei einer aktivierten Locale, die nicht die Standardsprache ist, fehlt, nicht lesbar oder syntaktisch ungültig ist, THEN THE Frontend SHALL diese Locale nicht in der Sprachauswahl anbieten, die Standardsprache verwenden, falls diese Locale aktiv war, und den Fehler mit der betroffenen Locale protokollieren.

### Requirement 14: Mehrsprachige Listings in der API

**User Story:** Als AI_Agent möchte ich Listings in einer gewünschten Sprache abrufen und erkennen, in welcher Sprache die Inhalte geliefert wurden, damit ich Nutzern passende Texte bereitstellen kann.

#### Acceptance Criteria

1. THE Listing_Store SHALL für jedes Listing genau eine Originalsprache als Locale nach BCP 47 sowie Titel und Beschreibung in dieser Originalsprache speichern.
2. THE Listing_Store SHALL je Listing 0 bis 20 weitere Sprachfassungen mit jeweils genau einer Locale nach BCP 47, einem Titel und einer Beschreibung speichern, wobei jede Locale je Listing höchstens einmal vorkommt, die Originalsprache eingeschlossen.
3. WHEN eine Such- oder Detailanfrage eine gewünschte Locale über einen Sprachparameter oder den Header Accept-Language angibt, THE Search_API SHALL je Listing die Sprachfassung zurückgeben, deren Locale ohne Beachtung der Groß-/Kleinschreibung exakt der gewünschten Locale entspricht, wobei Titel und Beschreibung aus derselben Sprachfassung stammen.
4. IF für ein Listing keine Sprachfassung mit exakt passender Locale vorhanden ist, aber eine Sprachfassung mit demselben primären Sprach-Subtag (z. B. „de“ für die gewünschte Locale „de-AT“), THEN THE Search_API SHALL diese Sprachfassung zurückgeben.
5. IF für ein Listing weder eine exakt passende Sprachfassung noch eine Sprachfassung mit demselben primären Sprach-Subtag vorhanden ist, oder die Anfrage weder einen Sprachparameter noch einen auswertbaren Header Accept-Language enthält, THEN THE Search_API SHALL Titel und Beschreibung in der Originalsprache des Listings zurückgeben.
6. WHEN der Header Accept-Language mehrere Sprachbereiche enthält und kein Sprachparameter angegeben ist, THE Search_API SHALL die Sprachbereiche je Listing in absteigender Reihenfolge ihres q-Werts (bei gleichem q-Wert in der Reihenfolge ihres Auftretens) prüfen, die erste nach den Kriterien 3 und 4 vorhandene Sprachfassung zurückgeben und Sprachbereiche mit q-Wert 0 sowie syntaktisch ungültige Einträge unberücksichtigt lassen, ohne einen Fehler zurückzugeben.
7. THE Search_API SHALL für jedes zurückgegebene Listing in Such- und Detailantworten die Locale der gelieferten Sprachfassung in einem eigenen Antwortfeld angeben und die Locale der Originalsprache in einem weiteren eigenen Antwortfeld.
8. WHEN eine Anfrage sowohl einen Sprachparameter als auch den Header Accept-Language enthält, THE Search_API SHALL ausschließlich den Sprachparameter zur Auswahl der Sprachfassung verwenden und den Header Accept-Language nicht auswerten.
9. IF der Sprachparameter einer Such- oder Detailanfrage leer ist, mehr als 35 Zeichen umfasst oder keine syntaktisch gültige Locale nach BCP 47 enthält, THEN THE Search_API SHALL den Statuscode 400 mit einer maschinenlesbaren Fehlerbeschreibung zurückgeben, die den Sprachparameter als fehlerhaften Parameter nennt, und keine Listings zurückgeben.
10. THE Search_API SHALL die Angebotsart jedes Angebots sowie Immobiliengruppe und Listing_Typ in Such- und Detailantworten unabhängig von der gewünschten und der gelieferten Sprachfassung als identische sprachneutrale Codes zurückgeben.

### Requirement 15: Konfigurierbare Immobilien-Taxonomie

**User Story:** Als Nutzer oder AI_Agent möchte ich nach Immobiliengruppen oder konkreten Listing_Typen filtern, und als Administrator möchte ich die Taxonomie ohne Code-Änderung erweitern, damit die Plattform an unterschiedliche Märkte angepasst werden kann.

#### Acceptance Criteria

1. THE Platform SHALL die Immobilien_Taxonomie aus einer Konfigurationsquelle beziehen, in der jede Immobiliengruppe und jeder Listing_Typ einen sprachneutralen Code von 1 bis 64 Zeichen hat, der über alle Immobiliengruppen und Listing_Typen hinweg eindeutig ist, und in der jeder Listing_Typ genau einer Immobiliengruppe zugeordnet ist.
2. THE Platform SHALL eine Standard-Taxonomie bereitstellen, die mindestens die Immobiliengruppen Wohnung (mit mindestens den Listing_Typen Apartment, Eigentumswohnung, Penthouse, Loft), Haus (mit mindestens den Listing_Typen Einfamilienhaus, Villa, Reihenhaus, Doppelhaushälfte), Grundstück und Gewerbe enthält, wobei jede dieser Immobiliengruppen mindestens einen Listing_Typ enthält.
3. WHEN ein Administrator der Konfiguration der Immobilien_Taxonomie eine Immobiliengruppe oder einen Listing_Typ hinzufügt und die Platform neu startet, THE Platform SHALL den neuen Eintrag ohne Änderung des Anwendungs-Quellcodes in Search_API (als gültigen Filterwert und im Discovery-Endpunkt), MCP_Server, API_Schema und Frontend verfügbar machen.
4. IF die Konfiguration der Immobilien_Taxonomie beim Start einen doppelten Code, einen leeren oder mehr als 64 Zeichen langen Code oder einen Listing_Typ ohne zugeordnete, in der Konfiguration definierte Immobiliengruppe enthält, THEN THE Platform SHALL den Start abbrechen, keine Anfragen annehmen und einen Fehler ausgeben, der jeden betroffenen Code und die Art des Verstoßes benennt.
5. WHEN eine Suchanfrage einen Immobiliengruppen-Filter mit genau einem Immobiliengruppen-Code enthält, THE Search_API SHALL ausschließlich Listings zurückgeben, deren Listing_Typ der angegebenen Immobiliengruppe zugeordnet ist, wobei der Code als exakte, Groß-/Kleinschreibung beachtende Übereinstimmung ausgewertet und mit allen weiteren Filtern der Suchanfrage per UND verknüpft wird.
6. WHEN eine Suchanfrage einen Listing_Typ-Filter mit 1 bis 50 Codes enthält, THE Search_API SHALL ausschließlich Listings zurückgeben, deren Listing_Typ einem der angegebenen Codes entspricht, wobei die Codes untereinander per ODER und mit allen weiteren Filtern der Suchanfrage per UND verknüpft werden.
7. IF eine Suchanfrage sowohl einen Immobiliengruppen-Filter als auch einen Listing_Typ-Filter enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe beider Felder zurückgeben, ohne die Suche auszuführen.
8. IF eine Suchanfrage einen Immobiliengruppen- oder Listing_Typ-Code enthält, der nicht in der aktuell geladenen Immobilien_Taxonomie definiert ist, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe jedes unbekannten Codes zurückgeben, ohne die Suche auszuführen.
9. WHEN ein AI_Agent die Immobilien_Taxonomie über den Discovery-Endpunkt abruft, THE Search_API SHALL alle in der aktuell geladenen Immobilien_Taxonomie definierten Immobiliengruppen jeweils mit ihrem Code und der vollständigen Liste der zugeordneten Listing_Typ-Codes in maschinenlesbarer Form zurückgeben.
10. IF eine Suchanfrage einen Listing_Typ-Filter mit 0 Codes oder mehr als 50 Codes oder einen Immobiliengruppen-Filter mit mehr als einem Code enthält, THEN THE Search_API SHALL den Statuscode 400 und eine maschinenlesbare Fehlerbeschreibung mit Angabe des betroffenen Feldes und der zulässigen Anzahl zurückgeben, ohne die Suche auszuführen.
11. WHEN eine Suchanfrage einen gültigen Immobiliengruppen- oder Listing_Typ-Filter enthält und kein Listing alle Filterkriterien erfüllt, THE Search_API SHALL eine erfolgreiche Antwort mit einer leeren Ergebnisliste zurückgeben.

### Requirement 16: Medien und virtuelle 3D-Touren

**User Story:** Als Nutzer möchte ich Bilder und virtuelle 3D-Touren einer Immobilie sehen, und als Administrator möchte ich nur vertrauenswürdige Tour_Anbieter zulassen, damit das Frontend vor beliebigen Fremdinhalten geschützt ist.

#### Acceptance Criteria

1. WHERE ein Listing Medien enthält, THE Listing_Store SHALL bis zu 50 Medien je Listing mit je einer absoluten https-URL (1 bis 2.048 Zeichen) in der vom Connector gelieferten Reihenfolge speichern.
2. WHERE ein Listing 3D_Touren enthält, THE Listing_Store SHALL bis zu 10 3D_Touren je Listing mit je einer absoluten https-Tour-URL (1 bis 2.048 Zeichen) und dem Code des Tour_Anbieters speichern, dem der Hostname der Tour-URL in der Tour_Erlaubnisliste zugeordnet ist.
3. WHEN ein Connector ein Listing mit Medien oder 3D_Touren importiert, THE Connector_Framework SHALL die gültigen Medien und 3D_Touren gemeinsam mit dem Listing in den Listing_Store übernehmen und dabei die zuvor für dieses Listing gespeicherten Medien und 3D_Touren vollständig durch die neu importierten ersetzen.
4. IF eine importierte 3D_Tour eine Tour-URL enthält, deren Hostname nicht exakt (ohne Berücksichtigung der Groß-/Kleinschreibung) mit einem zulässigen Hostnamen eines Tour_Anbieters der Tour_Erlaubnisliste übereinstimmt, THEN THE Connector_Framework SHALL die betroffene 3D_Tour verwerfen, das Listing mit seinen übrigen gültigen Medien und 3D_Touren speichern und die verworfene Tour-URL zusammen mit Listing-Bezeichner und Connector protokollieren.
5. IF ein importiertes Medium oder eine importierte 3D_Tour keine gültige https-URL enthält (URL fehlt, ist nicht absolut, verwendet ein anderes Schema als https, enthält keinen Hostnamen oder ist länger als 2.048 Zeichen), THEN THE Connector_Framework SHALL das betroffene Medium bzw. die betroffene 3D_Tour verwerfen, das Listing mit seinen übrigen gültigen Medien und 3D_Touren speichern und Listing-Bezeichner, Connector und den Verwerfungsgrund protokollieren.
6. WHEN ein Nutzer die Detailansicht eines Listings mit 3D_Touren öffnet, THE Frontend SHALL ausschließlich 3D_Touren einbetten, deren Tour-URL-Hostname zum Zeitpunkt der Anzeige exakt (ohne Berücksichtigung der Groß-/Kleinschreibung) mit einem zulässigen Hostnamen eines Tour_Anbieters der Tour_Erlaubnisliste übereinstimmt.
7. IF eine 3D_Tour zum Zeitpunkt der Anzeige keinem Tour_Anbieter der Tour_Erlaubnisliste zugeordnet ist, THEN THE Frontend SHALL die 3D_Tour nicht einbetten, die übrigen Inhalte der Detailansicht einschließlich der zugelassenen 3D_Touren weiterhin anzeigen und den Vorgang mit Listing-Bezeichner und Hostname protokollieren.
8. WHEN ein Administrator der Tour_Erlaubnisliste einen Tour_Anbieter mit zulässigen Hostnamen hinzufügt, THE Platform SHALL nach dem nächsten Neustart 3D_Touren dieses Tour_Anbieters bei jedem nachfolgenden Import ohne Änderung des Anwendungs-Quellcodes akzeptieren und in der Detailansicht einbetten.
9. WHEN eine Suchanfrage den Filter „hat 3D_Tour" mit dem Wert wahr enthält, THE Search_API SHALL ausschließlich Listings zurückgeben, die mindestens eine 3D_Tour enthalten, deren Tour-URL-Hostname zum Zeitpunkt der Suchanfrage einem Tour_Anbieter der Tour_Erlaubnisliste zugeordnet ist.
10. WHEN ein Nutzer die Detailansicht eines Listings öffnet, THE Frontend SHALL alle gespeicherten Medien des Listings als Bilder in der im Listing_Store gespeicherten Reihenfolge anzeigen.
11. IF ein importiertes Listing mehr als 50 gültige Medien oder mehr als 10 gültige 3D_Touren enthält, THEN THE Connector_Framework SHALL die ersten 50 Medien bzw. die ersten 10 3D_Touren in der gelieferten Reihenfolge speichern, die überzähligen verwerfen und deren Anzahl mit Listing-Bezeichner und Connector protokollieren.
12. IF ein Bild in der Detailansicht nicht geladen werden kann, THEN THE Frontend SHALL an seiner Stelle einen Platzhalter anzeigen und die übrigen Medien und Inhalte der Detailansicht weiterhin anzeigen.

### Requirement 17: Zugangsschutz und Rate-Limiting der öffentlichen API

**User Story:** Als Administrator möchte ich die öffentliche Search_API und den MCP_Server vor Überlastung und Missbrauch schützen, damit Betriebskosten kontrollierbar bleiben.

#### Acceptance Criteria

1. THE Platform SHALL für jeden Client ein vom Administrator konfigurierbares Rate_Limit auf alle Anfragen an die Search_API und den MCP_Server anwenden, bestehend aus einer maximalen Anzahl Anfragen (ganzzahlig, 1 bis 10.000) pro Zeitfenster (ganzzahlig, 1 bis 3.600 Sekunden), mit dem Standardwert 60 Anfragen pro 60 Sekunden, wobei Anfragen eines Clients an Search_API und MCP_Server gemeinsam auf dasselbe Rate_Limit angerechnet werden und ein Client bei deaktiviertem API_Key-basiertem Zugang anhand seiner Quell-IP-Adresse und bei aktiviertem API_Key-basiertem Zugang anhand seines API_Key identifiziert wird.
2. IF ein Client das Rate_Limit überschreitet, THEN THE Search_API SHALL die Anfrage mit dem Statuscode 429, einem maschinenlesbaren Fehlercode, der die Überschreitung des Rate_Limit kennzeichnet, und der Angabe der Wartezeit in ganzen Sekunden (mindestens 1) bis zur nächsten zulässigen Anfrage beantworten, ohne die Anfrage zu verarbeiten und ohne den Datenbestand der Platform zu verändern.
3. IF ein Client das Rate_Limit beim Aufruf eines Agent_Tool überschreitet, THEN THE MCP_Server SHALL den Aufruf mit demselben maschinenlesbaren Fehlercode wie die Search_API und der Angabe der Wartezeit in ganzen Sekunden (mindestens 1) ablehnen, ohne das Agent_Tool auszuführen.
4. WHERE der API_Key-basierte Zugang vom Administrator aktiviert ist, THE Platform SHALL ausschließlich Anfragen an die Search_API und den MCP_Server verarbeiten, die einen gültigen API_Key enthalten, wobei ein API_Key gültig ist, wenn er vom Administrator angelegt und weder widerrufen noch abgelaufen ist.
5. IF der API_Key-basierte Zugang aktiviert ist und eine Anfrage an die Search_API keinen oder einen ungültigen API_Key enthält, THEN THE Search_API SHALL den Statuscode 401 und einen maschinenlesbaren Fehlercode, der zwischen fehlendem und ungültigem API_Key unterscheidet, zurückgeben, ohne die Anfrage zu verarbeiten.
6. WHERE der API_Key-basierte Zugang vom Administrator aktiviert ist, THE Platform SHALL je API_Key ein eigenes Rate_Limit mit denselben Wertebereichen wie in Kriterium 1 konfigurierbar machen und für API_Keys ohne eigenes Rate_Limit das globale Rate_Limit aus Kriterium 1 anwenden.
7. IF der API_Key-basierte Zugang aktiviert ist und ein Aufruf eines Agent_Tool am MCP_Server keinen oder einen ungültigen API_Key enthält, THEN THE MCP_Server SHALL den Aufruf mit demselben maschinenlesbaren Fehlercode wie die Search_API in Kriterium 5 ablehnen, ohne das Agent_Tool auszuführen.
8. IF der Administrator ein Rate_Limit mit einer Anzahl Anfragen oder einem Zeitfenster außerhalb der in Kriterium 1 genannten Wertebereiche speichert, THEN THE Platform SHALL die Änderung mit einer Fehlermeldung, die den ungültigen Wert benennt, ablehnen und das zuvor gültige Rate_Limit unverändert beibehalten.
9. WHEN der Administrator ein gültiges Rate_Limit oder die Aktivierung bzw. Deaktivierung des API_Key-basierten Zugangs speichert, THE Platform SHALL die Änderung innerhalb von 60 Sekunden ohne Neustart der Search_API oder des MCP_Server auf alle nachfolgenden Anfragen anwenden.

### Requirement 18: Datenschutz (DSGVO)

**User Story:** Als Administrator möchte ich, dass personenbezogene Daten nur im erlaubten Umfang gespeichert und auf Anforderung gelöscht werden, damit die Plattform DSGVO-konform betrieben werden kann.

#### Acceptance Criteria

1. WHEN ein Connector ein Listing importiert, THE Connector_Framework SHALL vor der Speicherung jedes Personenbezogene_Feld verwerfen, dessen Feldname nicht in der PII_Feld_Erlaubnisliste enthalten ist, und das Listing mit allen übrigen Feldern unverändert speichern.
2. WHEN das Connector_Framework ein Personenbezogenes_Feld verwirft, THE Connector_Framework SHALL den Feldnamen, den Listing-Bezeichner und die Datenquelle protokollieren, ohne den Feldwert oder Teile davon zu protokollieren.
3. IF die PII_Feld_Erlaubnisliste leer oder nicht konfiguriert ist, THEN THE Connector_Framework SHALL alle Personenbezogenen_Felder jedes importierten Listings vor der Speicherung verwerfen und das Listing mit allen übrigen Feldern speichern.
4. WHEN ein Administrator eine Löschanfrage für einen Listing-Bezeichner oder eine Datenquelle auslöst, THE Listing_Store SHALL innerhalb von 24 Stunden nach Auslösung alle betroffenen Listings – bei einem Listing-Bezeichner genau das Listing mit diesem Bezeichner, bei einer Datenquelle alle Listings dieser Datenquelle – einschließlich ihrer Sprachfassungen, Medien-Verweise, 3D_Touren und Personenbezogenen_Felder entfernen, wobei eine Löschanfrage als ausgeführt gilt, sobald alle betroffenen Listings entfernt sind.
5. WHEN eine Löschanfrage ausgeführt wurde, THE Search_API SHALL für jeden entfernten Listing-Bezeichner bei jeder nachfolgenden Abfrage den Statuscode 404 zurückgeben und keines der entfernten Listings in einem Suchergebnis liefern.
6. WHEN eine Löschanfrage ausgeführt wurde, THE Platform SHALL jeden entfernten Listing-Bezeichner in die Löschsperrliste aufnehmen und dort so lange führen, bis ein Administrator den Eintrag ausdrücklich entfernt.
7. IF ein Connector ein Listing importiert, dessen Bezeichner in der Löschsperrliste enthalten ist, THEN THE Connector_Framework SHALL das Listing vollständig abweisen, keine Daten des Listings speichern und die Abweisung mit Listing-Bezeichner, Datenquelle und dem Grund „Löschsperre" protokollieren.
8. WHEN eine Löschanfrage ausgeführt wurde, THE Platform SHALL Zeitpunkt der Auslösung, Zeitpunkt der Ausführung, auslösenden Administrator, Löschkriterium (Bezeichner oder Datenquelle) und Anzahl der entfernten Listings protokollieren, ohne die Inhalte der entfernten Personenbezogenen_Felder zu protokollieren.
9. IF eine Löschanfrage einen Listing-Bezeichner oder eine Datenquelle angibt, zu dem bzw. der im Listing_Store kein Listing existiert, THEN THE Platform SHALL die Löschanfrage mit einer Fehlermeldung, die das nicht gefundene Löschkriterium benennt, an den Administrator zurückweisen und keine Daten verändern.
10. IF eine Löschanfrage innerhalb von 24 Stunden nach Auslösung nicht vollständig ausgeführt wurde, THEN THE Platform SHALL den auslösenden Administrator mit einer Meldung benachrichtigen, die die Anzahl der noch nicht entfernten Listings angibt, und die Löschanfrage bis zur vollständigen Ausführung als offen führen.
11. IF ein Benutzer ohne Administrator-Rolle eine Löschanfrage auslöst, THEN THE Platform SHALL die Löschanfrage mit einer Fehlermeldung, die die fehlende Berechtigung angibt, zurückweisen und keine Daten verändern.

### Requirement 19: MCP-Schnittstelle für AI-Agents

**User Story:** Als AI_Agent möchte ich Immobilien über das Model Context Protocol suchen und abrufen, damit ich die Plattform ohne individuelle API-Integration als Werkzeug nutzen kann.

#### Acceptance Criteria

1. THE MCP_Server SHALL genau die drei Agent_Tools search_listings, get_listing und list_property_types bereitstellen, wobei keines dieser Agent_Tools Listings, Search_Filter-Konfigurationen oder die Immobilien_Taxonomie verändert.
2. WHEN ein AI_Agent die verfügbaren Agent_Tools abfragt, THE MCP_Server SHALL für jedes der drei Agent_Tools eine maschinenlesbare Beschreibung mit Name, Zweck sowie allen Eingabeparametern inklusive Datentyp, Kennzeichnung als Pflicht- oder optionaler Parameter, Standardwert und zulässigem Wertebereich zurückgeben, wobei Datentypen, Pflichtangaben, Standardwerte und Wertebereiche mit dem API_Schema übereinstimmen.
3. WHEN ein AI_Agent search_listings mit Search_Filter-Werten, Paginierungsparametern und gewünschter Sprache aufruft, THE MCP_Server SHALL dieselben Listings in derselben Reihenfolge, mit denselben Feldwerten und denselben Paginierungsangaben (Verweis auf die nächste Ergebnisseite, Seitengröße) zurückgeben wie die Search_API für eine Suchanfrage mit identischen Parametern und für nicht angegebene optionale Parameter dieselben Standardwerte wie die Search_API anwenden.
4. WHEN ein AI_Agent get_listing mit einem Listing-Bezeichner und optional einer gewünschten Sprache aufruft, THE MCP_Server SHALL denselben Listing-Datensatz mit denselben Feldwerten und derselben Sprachauswahl (einschließlich desselben Fallback-Verhaltens bei nicht verfügbarer Sprache) zurückgeben wie die Search_API für eine Detailanfrage mit identischen Parametern.
5. WHEN ein AI_Agent list_property_types aufruft, THE MCP_Server SHALL die zum Aufrufzeitpunkt konfigurierte Immobilien_Taxonomie vollständig mit allen Immobiliengruppen und allen jeweils zugeordneten Listing_Typ-Codes zurückgeben, sodass jeder in der Immobilien_Taxonomie konfigurierte Listing_Typ-Code genau einer zurückgegebenen Immobiliengruppe zugeordnet ist.
6. IF ein Agent_Tool-Aufruf einen oder mehrere ungültige Parameter enthält (fehlender Pflichtparameter, falscher Datentyp oder Wert außerhalb des zulässigen Wertebereichs gemäß API_Schema), THEN THE MCP_Server SHALL den Aufruf ohne Rückgabe von Listing-Daten ablehnen und für jeden ungültigen Parameter denselben maschinenlesbaren Fehlercode und dieselbe Angabe des betroffenen Feldes zurückgeben, die die Search_API für die entsprechende Anfrage zurückgibt.
7. THE MCP_Server SHALL Filterauswertung, Validierung und Fehlercodes ausschließlich über dieselbe Domänenlogik wie die Search_API bereitstellen.
8. IF ein AI_Agent get_listing mit einem Listing-Bezeichner aufruft, für den die Search_API bei einer Detailanfrage mit identischen Parametern kein Listing zurückgibt, THEN THE MCP_Server SHALL den Aufruf mit demselben maschinenlesbaren Fehlercode ablehnen, den die Search_API für ein nicht gefundenes Listing zurückgibt, und keine Listing-Daten zurückgeben.
9. IF ein AI_Agent ein Agent_Tool mit einem Namen aufruft, der keinem der drei bereitgestellten Agent_Tools entspricht, THEN THE MCP_Server SHALL den Aufruf mit einer maschinenlesbaren Fehlerangabe ablehnen, die das Agent_Tool als unbekannt kennzeichnet.
10. IF die Domänenlogik der Search_API während eines Agent_Tool-Aufrufs nicht verfügbar ist oder der Aufruf nicht innerhalb von 10 Sekunden verarbeitet wird, THEN THE MCP_Server SHALL den Aufruf mit einer maschinenlesbaren Fehlerangabe abbrechen, die eine vorübergehende Nichtverfügbarkeit kennzeichnet, und keine unvollständigen Ergebnisse zurückgeben.
