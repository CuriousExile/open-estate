# Requirements Document

## Introduction

Dieses Dokument beschreibt die Erweiterung der Platform (Spec `real-estate-platform`) um eine Listing-Verwaltung für Agenturen und Plattform-Administratoren. Bisher gelangen Listings ausschließlich über Connectors in den Listing_Store; es gibt weder Benutzerkonten noch einen Listing-Status, eine Versionshistorie oder eine Benutzeroberfläche für die Verwaltung. Betriebs-Monitoring existiert nur als CloudWatch-Dashboard mit Alarmen für Operatoren.

Die Erweiterung umfasst:

- Agenturen mit Benutzern, Rollen und Maschinenzugängen sowie ein einheitliches Berechtigungsmodell,
- ein Agentur_Portal im bestehenden Angular-Frontend zum Anlegen, Bearbeiten und Verwalten eigener Listings,
- einen Listing_Status, mit dem Listings ohne Löschung aus der Öffentlichkeit genommen werden,
- eine unveränderliche Versionshistorie mit Vergleich und Wiederherstellung,
- ein feldgenaues Zusammenspiel von Import und manueller Pflege mit externer Referenz (Custom_Id),
- einen Admin_Modus, in dem Plattform_Admins agenturübergreifend alles verwalten,
- ein grundlegendes, erweiterbares Monitoring für Agenturen und Plattform_Admins.

Jede Funktion des Agentur_Portal ist über die Management_API mit identischen Berechtigungsprüfungen verfügbar; das Agentur_Portal nutzt ausschließlich die Management_API. Die bestehende Admin_API bleibt als eigenständige Betriebsschnittstelle unverändert bestehen. Datenmodell, Wertebereiche und Validierung von Listings richten sich nach Requirement 4, 12, 14, 15 und 16 der Spec `real-estate-platform`; das Listing-Schema und das API_Schema der Öffentlichen_Schnittstellen bleiben unverändert, alle dort verpflichtenden Felder bleiben verpflichtend. Für manuell angelegte Listings leitet die Platform die Provenienzfelder ab (Kriterien 4.5, 4.16 und 4.17). Es gibt keine bestehende Installation, zu der Kompatibilität gewahrt werden muss. Die Gestaltung des Agentur_Portal folgt `docs/design/README.md` (Stil-Referenz, kein Mockup).

Dieses Dokument konzentriert sich auf das *Was*. Technische Umsetzungsdetails werden im Design-Dokument behandelt.

## Glossary

Begriffe aus der Spec `real-estate-platform` (u. a. Platform, Listing, Listing_Store, Angebot, Angebotsart, Sprachfassung, Medium, 3D_Tour, Tour_Erlaubnisliste, Immobilien_Taxonomie, Connector, Connector_Framework, Connector_Lauf, Search_API, MCP_Server, Frontend, API_Schema, Rate_Limit, Löschanfrage, Löschsperrliste, Personenbezogenes_Feld, PII_Feld_Erlaubnisliste, Developer_Documentation) gelten unverändert. Zusätzlich gelten:

- **Admin_API**: Die bestehende, IAM-autorisierte Betriebsschnittstelle unter `/admin/*` (Löschanfragen, Löschsperrliste, API_Keys, Zugangsmodus, Rate_Limit) mit der CLI `open-estate-admin` (einschließlich Reload); sie bleibt unverändert bestehen.
- **Management_API**: Die neue, authentifizierte Schnittstelle der Platform für Agentur- und Plattformverwaltung (Agenturen, Benutzer, Listings, Listing_Status, Versionen, Monitoring sowie Plattform_Admin-Funktionen), die vom Agentur_Portal, vom Admin_Modus und von Maschinenzugängen gleichermaßen genutzt wird.
- **Agentur**: Eine Organisation (z. B. Maklerbüro), die Listings auf der Platform anbietet und verwaltet; identifiziert über einen eindeutigen Agentur-Bezeichner.
- **Benutzer**: Eine natürliche Person mit einem Konto bei der Platform, die sich über den Identity_Provider anmeldet.
- **Identity_Provider**: Der Amazon Cognito User Pool der Platform, der Benutzer authentifiziert und der Platform eine verifizierte Benutzeridentität liefert.
- **Rolle**: Eine benannte Menge von Berechtigungen. Die Platform kennt die Rollen Agentur_Mitglied, Agentur_Admin und Plattform_Admin.
- **Agentur_Mitglied**: Rolle eines Benutzers innerhalb genau einer Agentur mit Lese- und Schreibrechten auf die Listings dieser Agentur.
- **Agentur_Admin**: Rolle eines Benutzers innerhalb genau einer Agentur mit allen Rechten eines Agentur_Mitglied sowie der Verwaltung von Benutzern und Maschinenzugängen dieser Agentur.
- **Plattform_Admin**: Rolle eines Benutzers ohne Agenturzuordnung mit allen Berechtigungen über alle Agenturen hinweg.
- **Berechtigung**: Eine einzelne erlaubte Operation (z. B. `listing:write`, `listing:status`, `version:restore`, `agency:manage`, `monitoring:read`) bezogen auf einen Geltungsbereich (eine Agentur oder plattformweit).
- **Maschinenzugang**: Eine einer Agentur zugeordnete, von einem Agentur_Admin oder Plattform_Admin ausgestellte Zugangskennung für automatisierte Clients mit einer explizit festgelegten Teilmenge der für Maschinenzugänge zulässigen Berechtigungen.
- **Akteur**: Der Urheber einer Änderung: ein Benutzer, ein Maschinenzugang, ein Connector oder der Administrator der Admin_API.
- **Agentur_Portal**: Der angemeldete Bereich des Frontend, in dem Benutzer einer Agentur deren Listings verwalten und deren Monitoring einsehen.
- **Admin_Modus**: Der Bereich des Agentur_Portal, der ausschließlich Plattform_Admins zur Verfügung steht und agenturübergreifende Verwaltung und Plattform-Monitoring bereitstellt.
- **Listing_Status**: Der Veröffentlichungszustand eines Listings mit den Werten `ACTIVE` (öffentlich sichtbar) und `INACTIVE` (nicht öffentlich sichtbar, aber gespeichert).
- **Öffentliche_Schnittstellen**: Search_API, MCP_Server und die öffentlichen Seiten des Frontend.
- **Herkunft**: Die Angabe, ob ein Listing über einen Connector (`IMPORT`) oder über die Management_API (`MANUAL`) angelegt wurde.
- **Listing_Inhalt**: Alle Felder eines Listings gemäß Listing-Datenmodell (Requirement 4 der Spec `real-estate-platform`) einschließlich Angeboten, Sprachfassungen, Medien und 3D_Touren, ohne Listing-Bezeichner, Listing_Status, Custom_Id und Verwaltungsmetadaten.
- **Inhaltsfeld**: Ein Feldpfad des Listing_Inhalt in Zusammenführungsgranularität: jedes Feld, dessen Wert ein Skalar oder eine Liste ist, auf der obersten Ebene oder – rekursiv – innerhalb eines verschachtelten Objekts (z. B. `title`, `offers`, `media`, `translations`, `address.city`, `geo.lat`, `contact.email`). Verschachtelte Objekte sind keine eigenen Inhaltsfelder, sondern bestehen aus ihren Inhaltsfeldern; Listen (z. B. `offers`, `translations`, `media`, `tours`) sind jeweils genau ein Inhaltsfeld. Inhaltsfelder sind die Einheit für Import-Zusammenführung und Feldherkunft.
- **Provenienzfelder**: Die im API_Schema verpflichtenden Felder `source` (Datenquelle), `lastImportedAt` (Aktualitätszeitpunkt) und `lastRunId` (Änderungskennung) eines Listings; sie gehören nicht zum Listing_Inhalt.
- **Öffentliche_Detail_URL**: Die URL der öffentlichen Detailansicht eines Listings im Frontend in der Form `<Frontend-Origin>/listings/{Listing-Bezeichner}`, wobei der Frontend-Origin der bei der Bereitstellung konfigurierte Origin des Frontend ist.
- **Inhalts_Hash**: Ein über die kanonische Darstellung des Listing_Inhalt berechneter SHA-256-Wert, mit dem die Platform feststellt, ob sich der Listing_Inhalt geändert hat.
- **Custom_Id**: Eine optionale, von der Agentur vergebene externe Referenz eines Listings (z. B. die Kennung im CRM der Agentur) mit 1 bis 128 Zeichen, eindeutig innerhalb einer Agentur.
- **Import_Datensatz**: Ein von einem Connector gelieferter Datensatz nach dem Mapping in das Listing-Schema; er enthält optional Listing-Bezeichner, Custom_Id, Listing_Status und eine beliebige Teilmenge der Inhaltsfelder.
- **Importmodus**: Die je Connector bestimmte Art der Zusammenführung: `MERGE` (nur gelieferte Inhaltsfelder werden überschrieben; Standard) oder `REPLACE` (der Import_Datensatz gilt als vollständiger Listing_Inhalt). Die Connector-Konfiguration hat Vorrang vor dem Standard-Importmodus des Connector-Moduls; ohne beides gilt `MERGE`.
- **Standard-Importmodus**: Der von einem Connector-Modul festgelegte Importmodus, der gilt, wenn die Connector-Konfiguration keinen Importmodus angibt.
- **Feldherkunft**: Je Inhaltsfeld eines Listings der Änderungskanal, der Akteur und die Versionsnummer der letzten Änderung dieses Inhaltsfelds.
- **Version**: Ein unveränderlicher Eintrag der Versionshistorie, der den vollständigen Listing_Inhalt, Listing_Status, Custom_Id und Eigentümer-Agentur eines Listings nach einer Änderung sowie Versionsnummer, Akteur, Zeitpunkt, Änderungsart, Änderungskanal und die geänderten Inhaltsfelder mit ihrer vorherigen Feldherkunft enthält.
- **Versionshistorie**: Die nach Versionsnummer geordnete Folge aller Versionen eines Listings.
- **Versionsnummer**: Eine je Listing bei 1 beginnende, mit jeder Version um genau 1 steigende Ganzzahl.
- **Änderungskanal**: Der Weg, über den eine Änderung erfolgte: `PORTAL`, `API` (Maschinenzugang), `IMPORT`, `ADMIN` (Admin_Modus oder Admin_API).
- **Diff**: Die feldgenaue Gegenüberstellung zweier Versionen eines Listings mit allen hinzugefügten, entfernten und geänderten Feldern samt alten und neuen Werten.
- **Wiederherstellung**: Das Erzeugen einer neuen Version, deren Listing_Inhalt dem einer früheren Version entspricht.
- **Audit_Log**: Das unveränderliche Protokoll sicherheits- und verwaltungsrelevanter Aktionen mit Akteur, Zeitpunkt, Aktion, Ziel und Ergebnis.
- **Monitoring_Kennzahl**: Eine über einen stabilen Code identifizierte, zeitlich aggregierte Messgröße (z. B. `listing.detail_views`), die über die Management_API abrufbar ist.
- **Kennzahlenkatalog**: Die maschinenlesbare Liste aller verfügbaren Monitoring_Kennzahlen mit Code, Beschreibung, Einheit, Geltungsbereich (Agentur oder plattformweit) und Aggregationsintervall.
- **Detailaufruf**: Ein erfolgreicher Abruf eines Listings über die Detailfunktion einer Öffentlichen_Schnittstelle.
- **Sucheinblendung**: Das Erscheinen eines Listings in einer erfolgreichen Ergebnisseite einer Suche über eine Öffentliche_Schnittstelle.

## Requirements

### Requirement 1: Agenturen, Benutzer und Rollen

**User Story:** Als Plattform_Admin möchte ich Agenturen mit ihren Benutzern und Rollen verwalten, damit jede Agentur eigenständig, aber klar abgegrenzt auf der Platform arbeiten kann.

#### Acceptance Criteria

1. THE Platform SHALL jede Agentur mit eindeutigem Agentur-Bezeichner, Anzeigename (1 bis 200 Zeichen), Zustand (`ACTIVE` oder `SUSPENDED`) und Anlagezeitpunkt speichern.
2. THE Platform SHALL jedem Benutzer entweder genau eine Agentur mit genau einer der Rollen Agentur_Mitglied oder Agentur_Admin oder die Rolle Plattform_Admin ohne Agenturzuordnung zuweisen.
3. THE Platform SHALL Benutzer ausschließlich über den Identity_Provider authentifizieren und für jeden authentifizierten Aufruf der Management_API Rolle und Agentur des Benutzers aus dem Datenbestand der Platform ermitteln.
4. WHEN ein Plattform_Admin eine Agentur mit gültigem Anzeigenamen anlegt, THE Platform SHALL die Agentur im Zustand `ACTIVE` anlegen und den Agentur-Bezeichner zurückgeben.
5. WHEN ein Agentur_Admin oder Plattform_Admin einen Benutzer mit E-Mail-Adresse und Rolle zu einer Agentur hinzufügt, THE Platform SHALL dem Benutzer Zugang zur Agentur mit der angegebenen Rolle gewähren und für eine im Identity_Provider unbekannte E-Mail-Adresse ein Benutzerkonto mit Einladung anlegen.
6. WHEN ein Agentur_Admin oder Plattform_Admin die Rolle eines Benutzers der Agentur ändert oder den Benutzer aus der Agentur entfernt, THE Platform SHALL die Änderung innerhalb von 60 Sekunden auf alle nachfolgenden Aufrufe dieses Benutzers anwenden.
7. IF eine Rollenänderung oder Entfernung dazu führen würde, dass eine Agentur keinen Benutzer mit der Rolle Agentur_Admin mehr hat, THEN THE Platform SHALL die Änderung mit dem Statuscode 409 und einem maschinenlesbaren Fehlercode ablehnen und den bisherigen Zustand unverändert lassen.
8. WHEN ein Plattform_Admin eine Agentur in den Zustand `SUSPENDED` versetzt, THE Platform SHALL innerhalb von 60 Sekunden alle Aufrufe der Management_API durch Benutzer und Maschinenzugänge dieser Agentur mit dem Statuscode 403 ablehnen und alle Listings dieser Agentur über die Öffentlichen_Schnittstellen wie Listings mit Listing_Status `INACTIVE` behandeln, ohne den gespeicherten Listing_Status zu verändern.
9. WHEN ein Plattform_Admin eine Agentur aus dem Zustand `SUSPENDED` in den Zustand `ACTIVE` versetzt, THE Platform SHALL die Listings der Agentur innerhalb von 60 Sekunden gemäß ihrem gespeicherten Listing_Status über die Öffentlichen_Schnittstellen behandeln.

### Requirement 2: Einheitliches Berechtigungsmodell

**User Story:** Als Betreiber möchte ich ein einziges Berechtigungsmodell für Benutzeroberfläche und API, damit Agenturen ausschließlich ihre eigenen Daten sehen und ändern können, egal über welchen Kanal.

#### Acceptance Criteria

1. THE Platform SHALL jede Rolle und jeden Maschinenzugang auf eine festgelegte Menge von Berechtigungen mit Geltungsbereich abbilden und diese Abbildung in der Developer_Documentation veröffentlichen.
2. THE Management_API SHALL vor der Ausführung jeder Operation prüfen, ob der Akteur die für die Operation erforderliche Berechtigung im Geltungsbereich der betroffenen Agentur besitzt.
3. THE Agentur_Portal SHALL jede lesende und schreibende Operation ausschließlich über die Management_API ausführen.
4. IF ein Aufruf der Management_API keine oder eine ungültige bzw. abgelaufene Authentifizierung enthält, THEN THE Management_API SHALL den Statuscode 401 mit einem maschinenlesbaren Fehlercode zurückgeben, ohne die Operation auszuführen.
5. IF ein authentifizierter Akteur eine Operation aufruft, für die ihm die erforderliche Berechtigung fehlt, THEN THE Management_API SHALL den Statuscode 403 mit dem Fehlercode `FORBIDDEN` zurückgeben, ohne Daten zu verändern und ohne Daten der Zielressource zurückzugeben.
6. IF ein Akteur einer Agentur auf ein Listing, eine Version, einen Maschinenzugang, einen Benutzer, einen Connector_Lauf oder eine Monitoring_Kennzahl einer anderen Agentur zugreift, THEN THE Management_API SHALL dieselbe Antwort wie für eine nicht existierende Ressource (Statuscode 404) zurückgeben, ohne Daten zu verändern.
7. WHEN ein Akteur einer Agentur Listings, Versionen, Connector_Läufe oder Monitoring_Kennzahlen auflistet, THE Management_API SHALL ausschließlich Einträge der Agentur des Akteurs zurückgeben.
8. THE Management_API SHALL jede abgelehnte Operation (Statuscode 401 oder 403) mit Akteur (falls bekannt), Operation, Zielressource und Zeitpunkt im Audit_Log protokollieren.
9. THE Management_API SHALL auf jeden Akteur ein Rate_Limit mit denselben Wertebereichen wie Requirement 17.1 der Spec `real-estate-platform` anwenden und bei Überschreitung den Statuscode 429 mit Wartezeit in ganzen Sekunden zurückgeben, ohne die Operation auszuführen.

### Requirement 3: Maschinenzugänge für Agenturen

**User Story:** Als Agentur_Admin möchte ich Zugangsdaten für eigene Systeme (z. B. CRM) mit eingeschränkten Rechten ausstellen, damit diese Listings automatisiert verwalten können, ohne Benutzerkonten zu teilen.

#### Acceptance Criteria

1. WHEN ein Agentur_Admin oder Plattform_Admin einen Maschinenzugang für eine Agentur mit Bezeichnung (1 bis 100 Zeichen), Berechtigungsmenge und optionalem Ablaufzeitpunkt anlegt, THE Platform SHALL den Maschinenzugang anlegen und das Geheimnis genau einmal in der Antwort zurückgeben.
2. THE Platform SHALL das Geheimnis eines Maschinenzugangs ausschließlich in einer nicht umkehrbaren Form speichern.
3. IF die angeforderte Berechtigungsmenge eines Maschinenzugangs eine Berechtigung außerhalb der für Maschinenzugänge zulässigen Berechtigungen (Berechtigungen der Rolle Agentur_Admin ohne Verwaltung von Benutzern und Maschinenzugängen) oder außerhalb der Agentur enthält, THEN THE Platform SHALL die Anlage mit dem Statuscode 400 und der Angabe jeder unzulässigen Berechtigung ablehnen.
4. WHEN ein Maschinenzugang die Management_API aufruft, THE Management_API SHALL ausschließlich die Berechtigungen des Maschinenzugangs im Geltungsbereich seiner Agentur anwenden.
5. WHEN ein Agentur_Admin oder Plattform_Admin einen Maschinenzugang widerruft, THE Management_API SHALL alle nachfolgenden Aufrufe mit diesem Maschinenzugang innerhalb von 60 Sekunden mit dem Statuscode 401 ablehnen.
6. IF ein Maschinenzugang abgelaufen ist, THEN THE Management_API SHALL Aufrufe mit diesem Maschinenzugang mit dem Statuscode 401 und einem Fehlercode, der den Ablauf kennzeichnet, ablehnen.
7. THE Platform SHALL je Maschinenzugang Bezeichnung, Berechtigungsmenge, Anlagezeitpunkt, anlegenden Benutzer, Ablaufzeitpunkt, Widerrufszeitpunkt und Zeitpunkt der letzten Nutzung anzeigen, ohne das Geheimnis anzuzeigen.

### Requirement 4: Listings anlegen, bearbeiten und anzeigen

**User Story:** Als Agentur_Mitglied möchte ich eigene Listings anlegen, bearbeiten und einsehen, damit ich Immobilien ohne Connector direkt auf der Platform anbieten kann.

#### Acceptance Criteria

1. WHEN ein Akteur mit Berechtigung `listing:write` ein Listing mit gültigem Listing_Inhalt über die Management_API anlegt, THE Platform SHALL das Listing mit von der Platform vergebenem, eindeutigem Bezeichner, der Agentur des Akteurs als Eigentümer, Herkunft `MANUAL` und Version 1 speichern.
2. WHEN ein Listing angelegt wird, THE Platform SHALL den im Anlageauftrag angegebenen Listing_Status setzen und ohne Angabe den Listing_Status `INACTIVE` setzen.
3. THE Management_API SHALL Listing_Inhalt bei Anlage und Bearbeitung mit demselben Schema und denselben Wertebereichen validieren, die das Connector_Framework beim Import verwendet (Requirement 4, 12, 14, 15 und 16 der Spec `real-estate-platform`).
4. IF ein Anlage- oder Bearbeitungsauftrag ungültigen Listing_Inhalt enthält, THEN THE Management_API SHALL den Statuscode 400 mit einer maschinenlesbaren Fehlerbeschreibung je ungültigem Feld zurückgeben und den gespeicherten Datenbestand unverändert lassen.
5. WHERE ein Listing die Herkunft `MANUAL` hat, WHEN ein Anlage- oder Bearbeitungsauftrag keine Quell-URL enthält, THE Platform SHALL die Öffentliche_Detail_URL des Listings als Quell-URL speichern.
6. WHEN ein Akteur mit Berechtigung `listing:write` den Listing_Inhalt eines Listings seiner Agentur mit gültigem Inhalt und der aktuellen Versionsnummer als Bezugsversion ändert, THE Platform SHALL den Listing_Inhalt vollständig durch den übermittelten Inhalt ersetzen und eine neue Version erzeugen.
7. WHEN ein Bearbeitungsauftrag einen Listing_Inhalt mit demselben Inhalts_Hash wie die aktuelle Version und unveränderter Custom_Id enthält, THE Platform SHALL den Auftrag erfolgreich beantworten, ohne eine neue Version zu erzeugen.
8. IF ein Bearbeitungsauftrag eine Bezugsversion enthält, die nicht der aktuellen Versionsnummer des Listings entspricht, THEN THE Management_API SHALL den Statuscode 409 mit der aktuellen Versionsnummer zurückgeben und den Listing_Inhalt unverändert lassen.
9. IF ein Anlage- oder Bearbeitungsauftrag einen Bezeichner oder eine Custom_Id enthält, die in der Löschsperrliste steht, THEN THE Management_API SHALL den Auftrag mit dem Statuscode 409 und dem Grund „Löschsperre" ablehnen.
10. WHEN ein Listing über die Management_API angelegt oder bearbeitet wird, THE Platform SHALL Personenbezogene_Felder gemäß PII_Feld_Erlaubnisliste wie beim Import behandeln (Requirement 18.1 bis 18.3 der Spec `real-estate-platform`) und jedes verworfene Feld in der Antwort benennen.
11. WHEN ein Akteur mit Berechtigung `listing:write` bei Anlage oder Bearbeitung eine Custom_Id angibt, THE Platform SHALL die Custom_Id dem Listing zuordnen und als Teil der neuen Version speichern.
12. IF eine angegebene Custom_Id bereits einem anderen Listing derselben Agentur zugeordnet ist, THEN THE Management_API SHALL den Auftrag mit dem Statuscode 409 und dem Fehlercode `CUSTOM_ID_TAKEN` ablehnen und den Datenbestand unverändert lassen.
13. WHEN ein Akteur mit Berechtigung `listing:read` ein Listing seiner Agentur über den Listing-Bezeichner oder die Custom_Id abruft, THE Management_API SHALL den vollständigen Listing_Inhalt mit allen Sprachfassungen, Listing_Status, Custom_Id, Herkunft, Feldherkunft, aktueller Versionsnummer und Zeitpunkt der letzten Änderung unabhängig vom Listing_Status zurückgeben.
14. WHEN ein Akteur mit Berechtigung `listing:read` die Listings seiner Agentur auflistet, THE Management_API SHALL eine paginierte Liste mit Filtern nach Listing_Status, Herkunft, Angebotsart, Listing_Typ, Custom_Id und Freitext im Titel zurückgeben.
15. WHEN ein Listing mit Listing_Status `ACTIVE` angelegt oder geändert wird, THE Öffentliche_Schnittstellen SHALL den neuen Listing_Inhalt innerhalb von 60 Sekunden liefern.
16. WHEN für ein Listing eine Version erzeugt wird oder ein Connector_Lauf ein Listing ohne Änderung liefert, THE Platform SHALL `lastImportedAt` auf den Zeitpunkt dieses Vorgangs und `lastRunId` auf die Kennung des Connector_Lauf bzw. bei anderen Änderungskanälen auf eine aus Änderungskanal und Versionsnummer gebildete Kennung setzen.
17. THE Platform SHALL als `source` für Listings mit Herkunft `IMPORT` den Connector-Bezeichner und für Listings mit Herkunft `MANUAL` eine aus dem Agentur-Bezeichner der aktuellen Eigentümer-Agentur gebildete Kennung speichern.
18. FOR ALL Listings mit Herkunft `IMPORT` oder `MANUAL` SHALL die Darstellung des Listings über die Öffentlichen_Schnittstellen das unveränderte API_Schema der Spec `real-estate-platform` erfüllen und alle dort verpflichtenden Felder enthalten.
19. WHEN die Öffentliche_Detail_URL eines Listings aufgerufen wird, THE Frontend SHALL die öffentliche Detailansicht dieses Listings anzeigen.

### Requirement 5: Agentur_Portal

**User Story:** Als Agentur_Mitglied möchte ich eine Benutzeroberfläche zur Verwaltung unserer Listings, damit ich ohne technische Kenntnisse Angebote pflegen kann.

#### Acceptance Criteria

1. WHEN ein nicht angemeldeter Nutzer einen Bereich des Agentur_Portal aufruft, THE Frontend SHALL zur Anmeldung über den Identity_Provider weiterleiten und nach erfolgreicher Anmeldung den angeforderten Bereich anzeigen.
2. THE Agentur_Portal SHALL eine Listing-Übersicht mit Titel, Listing_Status, Herkunft, Custom_Id, Angebotsarten, Listing_Typ und Zeitpunkt der letzten Änderung für alle Listings der Agentur des Benutzers bereitstellen, einschließlich der Filter aus Kriterium 4.14.
3. THE Agentur_Portal SHALL Formulare zum Anlegen und Bearbeiten des vollständigen Listing_Inhalts und der Custom_Id bereitstellen: ein bis zwei Angebote (`SALE`, `RENT` mit Kaltmiete, Nebenkosten und Warmmiete), Listing_Typ aus der Immobilien_Taxonomie, Adresse, Zimmeranzahl, Fläche, Geokoordinaten, Sprachfassungen je aktivierter Locale, Medien in festgelegter Reihenfolge und 3D_Touren.
4. WHEN ein Benutzer ein Formular absendet, THE Agentur_Portal SHALL die Eingaben vor dem Aufruf der Management_API mit demselben Schema wie die Management_API validieren, jedes ungültige Feld benennen und die Eingaben erhalten.
5. IF die Management_API einen Bearbeitungsauftrag mit dem Statuscode 409 wegen veralteter Bezugsversion ablehnt, THEN THE Agentur_Portal SHALL den Benutzer darauf hinweisen, die Eingaben erhalten und den Diff zwischen der Bezugsversion und der aktuellen Version anzeigen.
6. THE Agentur_Portal SHALL Bedienelemente nur für Operationen anzeigen, für die der Benutzer die erforderliche Berechtigung besitzt.
7. THE Agentur_Portal SHALL alle sichtbaren Texte über Übersetzungsschlüssel gemäß Requirement 13 der Spec `real-estate-platform` auflösen und Farben, Typografie und Bedienelemente gemäß `docs/design/README.md` sowie der Theme_Config gestalten.
8. WHEN ein Benutzer ein Listing im Agentur_Portal öffnet, THE Agentur_Portal SHALL eine Vorschau anzeigen, die das Listing so darstellt, wie die öffentliche Detailansicht des Frontend es bei Listing_Status `ACTIVE` darstellen würde.
9. IF die Management_API eine Fehlerantwort zurückgibt oder nicht innerhalb von 10 Sekunden antwortet, THEN THE Agentur_Portal SHALL eine menschenlesbare Fehlermeldung anzeigen und alle Eingaben erhalten.

### Requirement 6: Listing_Status (Aktivieren und Deaktivieren)

**User Story:** Als Agentur_Mitglied möchte ich Listings deaktivieren und wieder aktivieren, damit ich Angebote vorübergehend aus der Öffentlichkeit nehmen kann, ohne sie zu löschen.

#### Acceptance Criteria

1. THE Listing_Store SHALL für jedes Listing genau einen Listing_Status mit dem Wert `ACTIVE` oder `INACTIVE` speichern.
2. WHEN ein Akteur mit Berechtigung `listing:status` den Listing_Status eines Listings seiner Agentur ändert, THE Platform SHALL den neuen Listing_Status speichern, eine neue Version erzeugen und Listing_Inhalt sowie Versionshistorie erhalten.
3. WHEN der Listing_Status eines Listings auf `INACTIVE` gesetzt wurde, THE Öffentliche_Schnittstellen SHALL das Listing innerhalb von 60 Sekunden aus allen Suchergebnissen entfernen.
4. IF eine Detailanfrage über die Search_API oder get_listing über den MCP_Server ein Listing mit Listing_Status `INACTIVE` betrifft, THEN THE Search_API und der MCP_Server SHALL denselben Statuscode und Fehlercode wie für einen nicht existierenden Listing-Bezeichner zurückgeben.
5. WHEN der Listing_Status eines Listings von `INACTIVE` auf `ACTIVE` gesetzt wurde, THE Öffentliche_Schnittstellen SHALL das Listing innerhalb von 60 Sekunden wieder mit seinem aktuellen Listing_Inhalt liefern.
6. WHILE ein Listing den Listing_Status `INACTIVE` hat, THE Management_API SHALL das Listing für berechtigte Akteure seiner Agentur und für Plattform_Admins weiterhin vollständig lesbar, bearbeitbar und mit Versionshistorie bereitstellen.
7. WHEN ein Connector_Lauf ein bestehendes Listing aktualisiert, THE Connector_Framework SHALL den gespeicherten Listing_Status des Listings unverändert lassen.
8. IF für ein Listing mit Listing_Status `INACTIVE` eine Löschanfrage ausgeführt wird, THEN THE Platform SHALL das Listing gemäß Requirement 18.4 der Spec `real-estate-platform` und Requirement 9 dieses Dokuments vollständig entfernen.
9. WHEN der Listing_Status auf einen Wert gesetzt wird, den das Listing bereits hat, THE Platform SHALL die Anfrage erfolgreich beantworten, ohne eine neue Version zu erzeugen.

### Requirement 7: Versionshistorie

**User Story:** Als Agentur_Mitglied möchte ich eine lückenlose Historie aller Änderungen an einem Listing sehen, damit ich nachvollziehen kann, wer wann was geändert hat.

#### Acceptance Criteria

1. WHEN der Listing_Inhalt, Listing_Status, die Custom_Id oder die Eigentümer-Agentur eines Listings über einen beliebigen Änderungskanal angelegt oder geändert wird, THE Platform SHALL atomar mit der Änderung eine neue Version mit der um 1 erhöhten Versionsnummer, dem vollständigen Listing_Inhalt, Listing_Status, Custom_Id und Eigentümer-Agentur nach der Änderung, Akteur, Änderungskanal, Änderungsart (`CREATE`, `UPDATE`, `STATUS`, `RESTORE`, `IMPORT`) und Zeitpunkt mit Zeitzone speichern.
2. WHEN eine Version erzeugt wird, THE Platform SHALL in der Version jedes geänderte Inhaltsfeld mit seiner Feldherkunft vor der Änderung speichern und die Feldherkunft des Listings für jedes geänderte Inhaltsfeld auf Änderungskanal, Akteur und Versionsnummer der neuen Version setzen.
3. WHEN ein Connector_Lauf ein Listing liefert, dessen zusammengeführter Listing_Inhalt denselben Inhalts_Hash wie die aktuelle Version hat und dessen Custom_Id unverändert ist, THE Platform SHALL keine neue Version erzeugen.
4. THE Platform SHALL gespeicherte Versionen über keine Operation der Management_API, der Admin_API oder des Connector_Framework verändern; ausgenommen ist ausschließlich das Entfernen gemäß Requirement 9.
5. WHEN ein Akteur mit Berechtigung `listing:read` die Versionshistorie eines Listings seiner Agentur abruft, THE Management_API SHALL alle vorhandenen Versionen absteigend nach Versionsnummer paginiert mit Versionsnummer, Akteur, Änderungskanal, Änderungsart, Zeitpunkt und den geänderten Inhaltsfeldern mit ihrer vorherigen Feldherkunft zurückgeben.
6. WHEN ein Akteur mit Berechtigung `listing:read` zwei Versionen desselben Listings vergleicht, THE Management_API SHALL den Diff der beiden Versionen zurückgeben.
7. FOR ALL Listings und alle Paare von Versionen desselben Listings SHALL das Anwenden des Diff auf die ältere Version genau den Listing_Inhalt, Listing_Status, Custom_Id und Eigentümer-Agentur der jüngeren Version ergeben.
8. THE Agentur_Portal SHALL die Versionshistorie eines Listings als Zeitleiste anzeigen, Versionen mit Änderungskanal `IMPORT` als Listenimport mit Connector und Connector_Lauf kennzeichnen und für zwei ausgewählte Versionen den Diff mit hervorgehobenen alten und neuen Werten darstellen.
9. THE Platform SHALL als Akteur für Benutzer den Benutzer-Bezeichner und Anzeigenamen, für Maschinenzugänge deren Bezeichnung, für Connectors den Connector-Bezeichner mit Connector_Lauf und für die Admin_API die IAM-Identität speichern.

### Requirement 8: Wiederherstellung früherer Versionen

**User Story:** Als Agentur_Mitglied möchte ich eine frühere Version eines Listings wiederherstellen, damit ich versehentliche oder fehlerhafte Änderungen rückgängig machen kann.

#### Acceptance Criteria

1. WHEN ein Akteur mit Berechtigung `version:restore` eine frühere Version eines Listings seiner Agentur mit der aktuellen Versionsnummer als Bezugsversion wiederherstellt, THE Platform SHALL eine neue Version mit Änderungsart `RESTORE`, dem Listing_Inhalt der gewählten Version und einem Verweis auf die Versionsnummer der wiederhergestellten Version erzeugen.
2. WHEN eine Wiederherstellung ausgeführt wird, THE Platform SHALL den aktuellen Listing_Status, die aktuelle Custom_Id und die aktuelle Eigentümer-Agentur des Listings unverändert lassen.
3. FOR ALL Listings und alle Versionen V SHALL nach der Wiederherstellung von V der Listing_Inhalt der neuen aktuellen Version gleich dem Listing_Inhalt von V sein, und alle zuvor vorhandenen Versionen SHALL unverändert erhalten bleiben.
4. IF der Listing_Inhalt der wiederherzustellenden Version nach den aktuell gültigen Validierungsregeln (z. B. geänderte Immobilien_Taxonomie oder Tour_Erlaubnisliste) ungültig ist, THEN THE Management_API SHALL die Wiederherstellung mit dem Statuscode 400 und einer Fehlerbeschreibung je ungültigem Feld ablehnen und das Listing unverändert lassen.
5. IF ein Wiederherstellungsauftrag eine Bezugsversion enthält, die nicht der aktuellen Versionsnummer entspricht, THEN THE Management_API SHALL den Statuscode 409 zurückgeben und das Listing unverändert lassen.
6. WHEN ein Benutzer im Agentur_Portal eine Wiederherstellung auslöst, THE Agentur_Portal SHALL vor der Ausführung den Diff zwischen aktueller und wiederherzustellender Version anzeigen und eine Bestätigung verlangen.

### Requirement 9: Aufbewahrung und Löschung der Versionshistorie

**User Story:** Als Plattform_Admin möchte ich, dass die Versionshistorie erhalten bleibt und bei Löschanfragen vollständig entfernt wird, damit Änderungen nachvollziehbar sind und die Platform DSGVO-konform bleibt.

#### Acceptance Criteria

1. THE Platform SHALL alle Versionen eines Listings ohne zeitliche oder zahlenmäßige Begrenzung aufbewahren, bis das Listing durch eine Löschanfrage entfernt wird.
2. WHEN eine Löschanfrage gemäß Requirement 18.4 der Spec `real-estate-platform` ausgeführt wird, THE Platform SHALL innerhalb derselben Frist von 24 Stunden alle Versionen und Diffs der betroffenen Listings entfernen.
3. WHEN eine Löschanfrage ausgeführt wurde, THE Management_API SHALL für jeden entfernten Listing-Bezeichner und jede entfernte Custom_Id Abrufe von Listing, Versionshistorie und Diff mit dem Statuscode 404 beantworten.
4. THE Platform SHALL im Audit_Log und in Monitoring_Kennzahlen ausschließlich Listing-Bezeichner, Feldnamen und Metadaten und keine Werte von Personenbezogenen_Feldern speichern, sodass diese nach einer Löschanfrage keine Werte von Personenbezogenen_Feldern der entfernten Listings enthalten.
5. IF eine Löschanfrage innerhalb von 24 Stunden die Versionen eines betroffenen Listings nicht vollständig entfernt hat, THEN THE Platform SHALL die Löschanfrage gemäß Requirement 18.10 der Spec `real-estate-platform` als offen führen und den Auslöser benachrichtigen.

### Requirement 10: Admin_Modus

**User Story:** Als Plattform_Admin möchte ich in Benutzeroberfläche und API agenturübergreifend alles verwalten können, damit ich Agenturen unterstützen und den Betrieb steuern kann.

#### Acceptance Criteria

1. THE Admin_Modus SHALL ausschließlich Benutzern mit der Rolle Plattform_Admin zur Verfügung stehen.
2. THE Platform SHALL einem Plattform_Admin jede Operation der Requirements 1, 3, 4, 6, 7 und 8 für jede Agentur und jedes Listing über die Management_API und den Admin_Modus ermöglichen.
3. THE Admin_Modus SHALL eine Agenturübersicht mit Anzeigename, Zustand, Anzahl Benutzer, Anzahl Listings je Listing_Status und Zeitpunkt der letzten Änderung bereitstellen.
4. THE Admin_Modus SHALL eine agenturübergreifende Listing-Übersicht mit den Filtern aus Kriterium 4.14 sowie einem Filter nach Agentur bereitstellen.
5. WHEN ein Plattform_Admin ein Listing einer Agentur ändert, THE Platform SHALL die Version mit dem Plattform_Admin als Akteur und dem Änderungskanal `ADMIN` speichern.
6. WHEN ein Plattform_Admin ein Listing ohne Agenturzuordnung oder ein Listing einer anderen Agentur einer Agentur zuweist, THE Platform SHALL die Eigentümer-Agentur ändern und eine Version mit Änderungsart `UPDATE` erzeugen.
7. THE Management_API SHALL ausschließlich Plattform_Admins zusätzlich die Funktionen der Admin_API (Löschanfragen auslösen und abfragen, Löschsperre aufheben, API_Keys, Rate_Limit und Zugangsmodus verwalten, Reload) mit derselben Domänenlogik, denselben Validierungsregeln und denselben Fehlercodes bereitstellen, und der Admin_Modus SHALL diese Funktionen als Bedienelemente anbieten, während die Admin_API unverändert bestehen bleibt.
8. WHEN ein Plattform_Admin eine destruktive Operation (Löschanfrage, Agentur sperren, Maschinenzugang widerrufen, Rolle Plattform_Admin entziehen) im Admin_Modus auslöst, THE Admin_Modus SHALL vor der Ausführung eine Bestätigung mit Angabe der Anzahl betroffener Listings bzw. Benutzer verlangen.
9. IF eine Änderung dazu führen würde, dass die Platform keinen Benutzer mit der Rolle Plattform_Admin mehr hat, THEN THE Platform SHALL die Änderung mit dem Statuscode 409 ablehnen.
10. WHEN die Platform bereitgestellt wird und noch kein Benutzer mit der Rolle Plattform_Admin existiert, THE Platform SHALL den in der Bereitstellungskonfiguration angegebenen Benutzer als Plattform_Admin anlegen.

### Requirement 11: Audit_Log

**User Story:** Als Plattform_Admin möchte ich alle Verwaltungsaktionen nachvollziehen können, damit Missbrauch und Fehlbedienung erkennbar sind.

#### Acceptance Criteria

1. WHEN eine Agentur, ein Benutzer, eine Rolle, ein Maschinenzugang, ein Rate_Limit, der Zugangsmodus oder eine Löschanfrage angelegt, geändert, widerrufen oder ausgeführt wird, THE Platform SHALL einen Eintrag mit Akteur, Änderungskanal, Aktion, Zielressource, Agentur, Ergebnis und Zeitpunkt im Audit_Log speichern.
2. WHEN ein Plattform_Admin eine Operation auf Ressourcen einer Agentur ausführt, THE Platform SHALL einen Eintrag im Audit_Log speichern.
3. THE Platform SHALL Einträge des Audit_Log über keine Operation der Management_API oder der Admin_API verändern oder entfernen.
4. WHEN ein Plattform_Admin das Audit_Log abfragt, THE Management_API SHALL die Einträge absteigend nach Zeitpunkt paginiert mit Filtern nach Akteur, Agentur, Aktion und Zeitraum zurückgeben.
5. WHEN ein Agentur_Admin das Audit_Log abfragt, THE Management_API SHALL ausschließlich Einträge mit der Agentur des Agentur_Admin zurückgeben.

### Requirement 12: Zusammenspiel von Import und manueller Verwaltung

**User Story:** Als Agentur_Mitglied möchte ich, dass ein Import nur die gelieferten Felder überschreibt und in der Historie klar als Listenimport erkennbar ist, damit manuelle Pflege und automatisierte Importe nebeneinander funktionieren.

#### Acceptance Criteria

1. THE Connector_Framework SHALL jeden Connector in seiner Konfiguration höchstens einer Agentur zuordnen; Listings von Connectors ohne Agenturzuordnung SHALL ausschließlich für Plattform_Admins verwaltbar sein.
2. WHEN ein Import_Datensatz verarbeitet wird, THE Connector_Framework SHALL das Ziel-Listing zuerst über den gelieferten Listing-Bezeichner und, falls kein Listing mit diesem Bezeichner existiert, über die gelieferte Custom_Id innerhalb der Agentur des Connectors bestimmen.
3. IF der Listing-Bezeichner und die Custom_Id eines Import_Datensatz auf zwei verschiedene Listings verweisen, THEN THE Connector_Framework SHALL den Import_Datensatz abweisen, beide Listings unverändert lassen und die Abweisung mit Listing-Bezeichner, Connector_Lauf und dem Grund „Identitätskonflikt" protokollieren.
4. IF ein Import_Datensatz weder einen Listing-Bezeichner noch eine Custom_Id enthält, THEN THE Connector_Framework SHALL den Import_Datensatz abweisen und die Abweisung mit Connector_Lauf und dem Grund „Identität fehlt" protokollieren.
5. WHEN für einen Import_Datensatz kein Ziel-Listing existiert, THE Connector_Framework SHALL ein Listing mit dem gelieferten Listing-Bezeichner oder, ohne gelieferten Bezeichner, mit einem von der Platform vergebenen Bezeichner, der Agentur des Connectors als Eigentümer, Herkunft `IMPORT`, Version 1 mit Änderungskanal `IMPORT` und dem im Import_Datensatz angegebenen Listing_Status bzw. ohne Angabe dem Listing_Status `ACTIVE` anlegen.
6. WHERE ein Connector den Importmodus `MERGE` hat, WHEN ein Import_Datensatz ein bestehendes Listing betrifft, THE Connector_Framework SHALL genau die im Import_Datensatz gelieferten Inhaltsfelder überschreiben (verschachtelte Objekte feldweise, Listen als Ganzes), mit dem Wert `null` gelieferte optionale Felder auf jeder Ebene einschließlich optionaler verschachtelter Objekte entfernen und alle übrigen Inhaltsfelder unverändert lassen.
7. WHERE ein Connector den Importmodus `REPLACE` hat, WHEN ein Import_Datensatz ein bestehendes Listing betrifft, THE Connector_Framework SHALL den Listing_Inhalt vollständig durch den Inhalt des Import_Datensatz ersetzen.
8. WHEN ein Import_Datensatz ein neues Listing anlegt, THE Connector_Framework SHALL nicht gelieferte optionale Inhaltsfelder mit dem im Listing-Schema festgelegten Standardwert oder ohne Standardwert leer anlegen.
9. IF der zusammengeführte Listing_Inhalt die Validierung gemäß Requirement 4 der Spec `real-estate-platform` nicht besteht, THEN THE Connector_Framework SHALL den Import_Datensatz abweisen, das Listing unverändert lassen und jedes ungültige Feld protokollieren.
10. WHEN ein Import_Datensatz ein bestehendes Listing betrifft, THE Connector_Framework SHALL einen gelieferten Listing_Status verwerfen und den gespeicherten Listing_Status unverändert lassen.
11. WHEN ein Import ein Inhaltsfeld überschreibt, dessen Feldherkunft einen anderen Änderungskanal als `IMPORT` aufweist, THE Platform SHALL das Inhaltsfeld in der Version als „durch Listenimport überschrieben" mit der vorherigen Feldherkunft kennzeichnen.
12. IF ein Import_Datensatz ein Listing einer anderen Agentur als der des Connectors betrifft oder ein Connector ohne Agenturzuordnung ein Listing mit Agenturzuordnung betrifft, THEN THE Connector_Framework SHALL den Import_Datensatz abweisen, das Listing unverändert lassen und die Abweisung mit Listing-Bezeichner, Connector_Lauf und Grund protokollieren.
13. WHEN ein Connector mit Agenturzuordnung ein Listing ohne Agenturzuordnung betrifft, das zuvor von demselben Connector importiert wurde, THE Connector_Framework SHALL die Agentur des Connectors als Eigentümer setzen und eine Version mit Änderungskanal `IMPORT` erzeugen.
14. IF ein Import_Datensatz eine Custom_Id liefert, die einem anderen Listing der Agentur zugeordnet ist als dem über den Listing-Bezeichner bestimmten Ziel-Listing, oder einen Bezeichner bzw. eine Custom_Id, die in der Löschsperrliste steht, THEN THE Connector_Framework SHALL den Import_Datensatz abweisen und den Grund („Identitätskonflikt" bzw. „Löschsperre") protokollieren.
15. THE Agentur_Portal SHALL für jedes Listing die Herkunft und für jedes Inhaltsfeld die Feldherkunft anzeigen und Inhaltsfelder hervorheben, die zuletzt durch einen Listenimport nach einer manuellen Änderung überschrieben wurden.
16. THE Connector_Framework SHALL den Importmodus eines Connectors aus dessen Konfiguration, ohne Angabe aus dem Standard-Importmodus des Connector-Moduls und ohne beides als `MERGE` bestimmen.
17. THE Connector_Framework SHALL für die mitgelieferten Connector-Module, die je Listing vollständige Datensätze liefern (Web-Crawler mit JSON-LD-Extraktion, relationale Datenbank, externe API), den Standard-Importmodus `REPLACE` festlegen, sodass ein an der Quelle entfallenes optionales Feld beim nächsten Import entfernt wird.

### Requirement 13: Monitoring für Agenturen

**User Story:** Als Agentur_Mitglied möchte ich den Zustand unserer Listings und Importe sowie einfache Nutzungszahlen sehen, damit ich Probleme erkenne und die Reichweite einschätzen kann.

#### Acceptance Criteria

1. WHEN ein Akteur mit Berechtigung `monitoring:read` die Übersicht seiner Agentur abruft, THE Management_API SHALL die Anzahl der Listings je Listing_Status und die Anzahl der Änderungen je Änderungskanal in den letzten 30 Tagen zurückgeben.
2. WHEN ein Akteur mit Berechtigung `monitoring:read` die Connector_Läufe seiner Agentur abruft, THE Management_API SHALL je Connector_Lauf Connector, Startzeitpunkt, Endzeitpunkt, Ergebnisstatus und die Anzahl angelegter, aktualisierter, unveränderter und abgewiesener Listings für mindestens die letzten 90 Tage zurückgeben.
3. WHEN ein Akteur mit Berechtigung `monitoring:read` die Fehler eines Connector_Lauf seiner Agentur abruft, THE Management_API SHALL je abgewiesenem Import_Datensatz den Listing-Bezeichner bzw. die Custom_Id, die betroffenen Felder und den Abweisungsgrund ohne Werte von Personenbezogenen_Feldern zurückgeben.
4. THE Platform SHALL je Listing die Anzahl der Detailaufrufe und Sucheinblendungen je Kalendertag (UTC) erfassen und mindestens 90 Tage aufbewahren, ohne IP-Adressen oder andere Kennungen der Aufrufer zu speichern.
5. WHEN ein Akteur mit Berechtigung `monitoring:read` Nutzungszahlen seiner Agentur für einen Zeitraum von 1 bis 90 Tagen abruft, THE Management_API SHALL die Detailaufrufe und Sucheinblendungen je Tag gesamt und je Listing zurückgeben.
6. THE Agentur_Portal SHALL eine Monitoring-Ansicht mit den Daten aus den Kriterien 1 bis 5 bereitstellen, einschließlich einer Liste der Connector_Läufe mit Ergebnisstatus `Fehler` oder mit abgewiesenen Import_Datensätzen.
7. THE Platform SHALL Monitoring-Daten der Agentur-Ansicht mit einer Verzögerung von höchstens 15 Minuten gegenüber dem Ereignis bereitstellen.

### Requirement 14: Monitoring für Plattform_Admins

**User Story:** Als Plattform_Admin möchte ich die Gesundheit der gesamten Platform in der Benutzeroberfläche sehen, damit ich Störungen erkenne, ohne die AWS-Konsole zu öffnen.

#### Acceptance Criteria

1. WHEN ein Plattform_Admin das Plattform-Monitoring für einen Zeitraum von 1 Stunde bis 30 Tagen abruft, THE Management_API SHALL je Endpunkt der Search_API, des MCP_Server und der Management_API die p95-Latenz, die Anzahl Anfragen und die Anzahl Antworten mit Statuscode 4xx, 429 und 5xx zurückgeben.
2. WHEN ein Plattform_Admin das Plattform-Monitoring abruft, THE Management_API SHALL den aktuellen Zustand jedes bestehenden Alarms der Platform (OK, Alarm, unzureichende Daten) mit Zeitpunkt der letzten Zustandsänderung zurückgeben.
3. WHEN ein Plattform_Admin die Connector_Läufe abruft, THE Management_API SHALL die Daten aus Kriterium 13.2 agenturübergreifend mit Filter nach Agentur, Connector und Ergebnisstatus zurückgeben.
4. WHEN ein Plattform_Admin die Agenturaktivität abruft, THE Management_API SHALL je Agentur die Anzahl der Änderungen je Änderungskanal, die Anzahl der Listings je Listing_Status sowie die Detailaufrufe und Sucheinblendungen für den gewählten Zeitraum zurückgeben.
5. WHEN ein Plattform_Admin den Umfang der Versionshistorie abruft, THE Management_API SHALL je Agentur und plattformweit die Anzahl gespeicherter Versionen und den belegten Speicher der Versionen in Bytes mit einer Verzögerung von höchstens 15 Minuten zurückgeben.
6. THE Admin_Modus SHALL eine Monitoring-Ansicht mit den Daten aus den Kriterien 1 bis 5 bereitstellen und Alarme im Zustand Alarm hervorgehoben anzeigen.
7. IF eine Monitoring-Datenquelle beim Abruf nicht innerhalb von 10 Sekunden antwortet, THEN THE Management_API SHALL die verfügbaren Daten zurückgeben und jede nicht verfügbare Kennzahl als nicht verfügbar kennzeichnen, und der Admin_Modus SHALL diese Kennzeichnung anzeigen.

### Requirement 15: Erweiterbare Monitoring-Basis

**User Story:** Als Entwickler der Platform möchte ich neue Monitoring_Kennzahlen ohne Umbau hinzufügen können, damit das Monitoring später ausgebaut werden kann.

#### Acceptance Criteria

1. THE Management_API SHALL den Kennzahlenkatalog über einen eigenen Endpunkt bereitstellen und für Akteure einer Agentur nur Monitoring_Kennzahlen mit Geltungsbereich Agentur auflisten.
2. THE Management_API SHALL jede Monitoring_Kennzahl über einen einheitlichen Endpunkt mit den Parametern Kennzahl-Code, Zeitraum, Aggregationsintervall und optionalen Dimensionen (Agentur, Listing, Connector, Endpunkt) als Zeitreihe in einem einheitlichen Antwortformat bereitstellen.
3. WHEN eine neue Monitoring_Kennzahl dem Kennzahlenkatalog hinzugefügt wird, THE Management_API SHALL Antworten für bestehende Kennzahl-Codes in Feldnamen und Datentypen unverändert lassen.
4. IF ein Abruf einen unbekannten Kennzahl-Code oder eine für den Akteur nicht zulässige Kennzahl enthält, THEN THE Management_API SHALL den Statuscode 400 bzw. 403 mit Angabe des Kennzahl-Codes zurückgeben.
5. THE Agentur_Portal SHALL Monitoring_Kennzahlen, die im Kennzahlenkatalog stehen, aber keine eigene Darstellung im Agentur_Portal haben, in einer generischen Zeitreihen-Darstellung anzeigen.

### Requirement 16: Vollständige API-Steuerung und Dokumentation

**User Story:** Als Entwickler einer Agentur möchte ich alles, was im Agentur_Portal möglich ist, auch über eine dokumentierte API ausführen, damit ich eigene Systeme anbinden kann.

#### Acceptance Criteria

1. THE Management_API SHALL für jede Operation des Agentur_Portal und des Admin_Modus einen Endpunkt mit derselben Validierung, denselben Berechtigungsprüfungen und denselben Fehlercodes bereitstellen.
2. THE Platform SHALL die Management_API in einem eigenen OpenAPI-Dokument beschreiben, das für jeden Endpunkt die erforderlichen Berechtigungen, alle Parameter mit Datentypen und Wertebereichen, alle Antwortformate und alle Fehlercodes einschließlich 401, 403, 404, 409 und 429 enthält.
3. THE Management_API SHALL für Fehlerantworten dasselbe maschinenlesbare Fehlerformat und denselben Fehlerkatalog wie die Search_API verwenden und neue Fehlercodes im Fehlerkatalog ergänzen.
4. THE Developer_Documentation SHALL für Maschinenzugänge ein vollständiges Beispiel für Authentifizierung, Anlegen eines Listings mit Custom_Id, Abruf über die Custom_Id, Ändern des Listing_Status, Abrufen der Versionshistorie und Wiederherstellen einer Version enthalten.
5. FOR ALL schreibenden Operationen der Management_API und alle Akteure ohne die erforderliche Berechtigung SHALL der Zustand von Listing_Store, Versionshistorie, Agenturen, Benutzern und Maschinenzugängen nach der abgelehnten Operation identisch mit dem Zustand davor sein.

## Abgrenzung

Nicht Bestandteil dieser Spec: Abrechnung/Pakete für Agenturen, Selbstregistrierung von Agenturen, Kontaktanfragen von Interessenten, Benachrichtigungen an Agenturen (E-Mail/Push), frei konfigurierbare Dashboards und Alarme für Agenturen, Massenimport per Datei-Upload im Agentur_Portal, Aufbewahrungsregeln oder Verdichtung der Versionshistorie (die Kennzahlen aus Kriterium 14.5 bilden die Entscheidungsgrundlage für eine spätere Begrenzung), gezielte Bereinigung Personenbezogener_Felder in älteren Versionen ohne Löschung des gesamten Listings, Mitgliedschaft eines Benutzers in mehreren Agenturen.
