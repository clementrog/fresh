PRD — Editorial Signal Engine V1
1. Vue d’ensemble

Editorial Signal Engine V1 aide des créateurs de contenu au sein d’une même entreprise à trouver de meilleures idées de posts LinkedIn à partir de signaux réels, internes et externes.
Un créateur peut être :

un founder

un team member

un expert métier

un compte corporate / brand voice

Le système ne sert pas une équipe contenu intermédiaire. Il sert directement les personnes qui publient.

L’objectif de V1 est simple :

capter des signaux utiles

les transformer en Content Opportunities

permettre à chaque profil de voir ses idées pertinentes

laisser l’utilisateur choisir un sujet

générer un draft V1 à la demande

Le système ne publie jamais automatiquement.

2. Objectif produit

Construire un système qui :

ingère des sources internes configurées

exécute des recherches marché configurées

transforme ces inputs en opportunités éditoriales actionnables

rattache ces opportunités à la bonne personne

permet à l’utilisateur de demander un draft

expose le tout dans un cockpit simple

L’expérience cible n’est pas :

“voici des signaux, clusters, insights intermédiaires”

L’expérience cible est :

“voici 8 idées de posts crédibles pour toi cette semaine, avec l’angle, le pourquoi maintenant, et les preuves.”

3. Utilisateurs
Utilisateurs principaux

Les créateurs eux-mêmes :

founders

dirigeants

experts

opérateurs

compte corporate

Chaque utilisateur :

voit les opportunités qui lui correspondent

choisit ses sujets

demande ses drafts

retravaille et publie lui-même

Il n’y a pas de middleware humain obligatoire entre le système et le créateur.

4. Périmètre V1
Inclus

ingestion quotidienne de sources internes sélectionnées

recherche marché 2 fois par semaine via requêtes configurées

création ou enrichissement direct de Content Opportunities

suggestion d’owner

traçabilité des preuves

draft V1 à la demande

cockpit Notion

profils de voice éditables

configuration éditoriale hors code

Postgres comme source de vérité

logs de coût / tokens

retries / idempotence / audit minimal

Hors scope

auto-publication LinkedIn

ingestion Slack

scraping LinkedIn

ingestion automatique des posts déjà publiés / drafts existants / idées passées depuis LinkedIn

learning layer automatique

Signal Feed comme objet utilisateur

Theme Cluster comme objet métier autonome

digest agent comme composant central

browsing autonome libre

custom app riche en V1

5. Principe central

Le système ne tourne pas autour du post.

Le système tourne autour de :

Content Opportunity

Une Content Opportunity est une opportunité éditoriale structurée, assez claire pour que l’utilisateur puisse immédiatement se projeter dans un post.

Elle relie :

un sujet

un angle

un moment

un owner potentiel

des preuves

un format suggéré

un état de workflow

Un draft ou un post publié n’est qu’une sortie possible d’une Content Opportunity.

6. Editorial judgment — comment le système décide ce qui est intéressant

Le système ne doit pas hardcoder ce qu’est un “bon post LinkedIn”.
Il doit utiliser une editorial lens configurable, stockée hors code, chargée au runtime.

Cette lens a 3 couches.

Layer 1 — Company editorial lens

Spécifique à chaque entreprise.

Contient :

les thèmes stratégiques

les territoires de parole

les verticales

la worldview de l’entreprise

les convictions / takes contrarians

ce qui est en train d’être lancé ou poussé

ce qui est sensible ou hors-limite

Layer 2 — Content philosophy

Définit ce qu’est une bonne opportunité éditoriale.

Exemples :

spécifique

prouvée

avec tension

utile

actuelle

non générique

Et ce qu’est une mauvaise opportunité :

trop vague

trop interne

sans angle

sans preuve

simple répétition d’un sujet déjà actif

Cette couche doit aussi expliquer :

ce qui crée une nouvelle opportunity

ce qui doit plutôt enrichir une opportunity existante

Layer 3 — LinkedIn craft knowledge

Base vivante d’hypothèses et d’observations sur :

formats

hooks

structures

patterns d’attention

patterns de crédibilité

types de posts qui obtiennent de l’engagement vs du respect

Ce n’est pas une liste de best practices figées.
C’est une connaissance versionnée et éditable.

Règle importante

Les 3 couches :

sont chargées au runtime

sont éditables

ne vivent pas dans le code

influencent le scoring et les décisions de l’Intelligence Agent

V1 shippe avec des defaults sensés pour les Layers 2 et 3.
Le Layer 1 doit être configuré par entreprise.

7. Sources V1
Sources internes
Notion

Pages et bases explicitement configurées.
Faible volume, fort signal.

Linear

tickets

status changes

comments

updates

Claap

transcriptions de réunions

métadonnées associées

Slack

Hors scope V1 ingestion.

Raison :

trop de bruit

API plus difficile

vrai sujet, mais pour V2

Sources externes
Market research runs

Deux fois par semaine, le système exécute des requêtes configurées.

Exemples :

RGDU 2026 payroll changes

Pennylane news

French payroll software

DSN compliance updates

Ces requêtes sont exécutées via un moteur de recherche configuré.
La V1 doit documenter explicitement :

quel search API est utilisé

combien de résultats sont récupérés par requête

comment ils sont résumés

quel objet est injecté dans le pipeline

Recommandation V1

utiliser un seul search API choisi explicitement

récupérer un nombre borné de résultats par query, par ex. 5 à 10

résumer les résultats avec le Layer 1 comme filtre de pertinence

injecter le résultat sous forme de Raw Source Item

Input manuel

Une surface “Market Findings” permet à un utilisateur d’ajouter :

une URL

un résumé court

une note facultative

Cela rentre dans le pipeline comme un Raw Source Item.

Explicitement exclus

Slack

ingestion automatique des posts existants

ingestion automatique des drafts existants

ingestion automatique des idées déjà développées

scraping LinkedIn

8. Architecture cible V1
Base centrale

Postgres est la source de vérité.
Supabase ou Neon sont adaptés.

Cockpit

Notion est la surface de lecture et de légère édition.

Notion n’est pas le cerveau.
Notion n’est pas le système de vérité des configs techniques.

Agents V1

Exactement 3 agents :

Ingestion Agent

Intelligence Agent

Draft Agent

9. Agent 1 — Ingestion Agent
Trigger

quotidien

pas de LLM

Rôle

lire les sources configurées

récupérer les nouveaux items depuis le dernier sync

normaliser les objets

stocker dans Postgres

gérer pagination, retries, rate limits

dédupliquer par ID de source

logger les runs

Output

Des Raw Source Items uniquement.

10. Agent 2 — Intelligence Agent

L’Intelligence Agent reste un seul agent, mais il fonctionne en 2 étapes séquentielles dans le même run.

Étape 1 — Filter / score
Trigger

quotidien après ingestion

deux fois par semaine pour les runs marché

Rôle

charger les nouveaux Raw Source Items

charger l’editorial lens

identifier quels items ont un vrai potentiel éditorial

scorer rapidement

filtrer le bruit

Cette étape doit être :

plus cheap

batchée agressivement

sans charger tout le contexte des opportunities

Objectif :
ne faire passer à l’étape 2 qu’une fraction des items.

Étape 2 — Create / enrich
Rôle

Pour les items retenus :

charger les opportunités actives récentes

charger les profils utilisateurs

décider :

create new opportunity

enrich existing opportunity

skip

proposer un owner

produire des preuves

produire un angle

produire le “why now”

produire hook suggestions et format suggéré

Cap d’overlap checking

Le système ne charge pas toutes les opportunities actives.
Il charge un ensemble borné, par exemple :

les 30 à 40 opportunities non archivées les plus récentes

Logique de dédup

Quand une opportunity active couvre déjà sensiblement le même sujet :

enrichir plutôt que recréer

Quand il y a doute :

créer une nouvelle opportunity

Sous-dédupliquer est préférable à sur-dédupliquer en V1.

11. Enrichment — comportement exact

L’enrichissement ne doit pas écraser les champs principaux d’une opportunity.

On ajoute un champ :

enrichmentLog

Append-only, horodaté.

Chaque entrée contient :

nouvelles preuves

éventuellement une suggestion d’angle update

éventuellement une suggestion de whyNow update

commentaire de contexte

Les champs système visibles principaux (title, angle, whatItsAbout, whyNow, etc.) restent stables.
L’utilisateur voit :

l’opportunity initiale

les enrichissements ajoutés

les suggestions d’évolution si elles existent

Ça permet d’éviter les overwrite tout en laissant l’histoire évoluer.

12. Agent 3 — Draft Agent
Trigger

À la demande utilisateur.

UX cible V1

Le polling Notion n’est pas l’UX cible.
La V1 doit prévoir un petit endpoint ou action dédiée qui déclenche rapidement la génération.

Le changement de statut Notion vers draft_requested peut rester :

un fallback

ou un mécanisme minimal si nécessaire

Mais la PRD doit considérer le polling comme un compromis, pas comme la cible idéale.

Rôle

charger la Content Opportunity

charger le profil de voice

charger le Layer 3 (LinkedIn craft)

charger les preuves

lire les editorialNotes s’il y en a

générer un V1 draft

Règle importante

Si editorialNotes existent, elles doivent être traitées comme des overrides humains sur l’angle / hook / direction.

Output

hook

body

structure adaptée au format

idée de visuel

confidence note

Le draft doit sonner comme la personne, pas comme un AI generic LinkedIn post.

13. Modèle de données
13.1 companies

Multi-tenant dès V1.

13.2 users

Profils créateurs, humains ou corporate.

Champs :

id

companyId

displayName

type (human / corporate)

language

baseProfile JSON

createdAt

updatedAt

Le baseProfile contient :

tone

style

preferred vocabulary

avoided vocabulary

typical structures

strong angles

weakFitTopics

examplePosts

doNot

Pas de learned layer en V1.

13.3 source_configs

Par entreprise et par source.

13.4 raw_source_items

Champs minimum :

id

companyId

source

externalId

type

title nullable

text

url

author

timestamp

metadata

fingerprint

processedAt

createdAt

13.5 content_opportunities

Objet central.

Champs :

id

companyId

title

angle

whatItsAbout

whatItsNotAbout

whyNow

suggestedFormat

formatRationale

hookSuggestion1

hookSuggestion2 nullable

ownerUserId nullable

ownerSuggestionUserId nullable

status

editorialNotes

enrichmentLog JSON / append-only

draftRequestedAt nullable

draftV1Id nullable

notionPageId nullable

createdAt

updatedAt

13.6 evidences

Table de preuves autonome.

Champs :

id

companyId

rawSourceItemId

source

sourceUrl

excerpt

timestamp

authorOrSpeaker

createdAt

13.7 opportunity_evidence

Table de jonction.

Champs :

opportunityId

evidenceId

relevanceNote

createdAt

Cela évite de dupliquer une même preuve quand elle sert à plusieurs opportunities.

13.8 draft_v1s

Champs :

id

opportunityId

title

hook

body

visualIdea

confidenceNote

createdAt

13.9 editorial_config

Versionnée par entreprise.

Champs :

id

companyId

version

layer1CompanyLens JSON

layer2ContentPhilosophy JSON

layer3LinkedInCraft JSON

createdAt

13.10 market_queries

Champs :

id

companyId

query

enabled

priority

createdAt

updatedAt

13.11 sync_runs

Audit log.

Champs :

id

companyId

agentType

status

startedAt

finishedAt

itemsFetched

itemsCreated

itemsUpdated

tokenInput

tokenOutput

estimatedCost

errorLog

14. États de workflow simplifiés

Les états doivent refléter de vraies actions humaines.

Content Opportunity.status

new

to_review

picked

draft_requested

draft_ready

v2_in_progress

published

parked

rejected

archived

Règle de TTL

Une opportunity restée en new ou to_review pendant plus de 14 jours passe automatiquement en parked.

Une opportunity parked :

n’apparaît plus dans le feed principal

reste enrichissable

peut redevenir active si de nouvelles preuves arrivent

SyncRun.status

running

completed

failed

partially_failed

Suppression de readiness

On ne garde pas de champ readiness séparé.
Trop de recouvrement avec status.

15. Notion comme cockpit V1

Notion est acceptable si le contrat d’écriture est clair.

Ownership rules
Champ	Écrit par système	Éditable humain
Title	Oui	Non
Angle	Oui	Non
What it’s about	Oui	Non
What it’s not about	Oui	Non
Why now	Oui	Non
Suggested format	Oui	Non
Hook suggestions	Oui	Non
Evidence log	Oui (append only)	Non
Owner suggestion	Oui	Oui
Status	Non	Oui
Editorial notes	Non	Oui
Draft V1	Oui	Oui
Règles

le système n’écrase pas les champs humains

le système enrichit via append

editorialNotes servent de guidance prioritaire au Draft Agent

Limites reconnues

Notion a :

des limites API

pas de vrai real-time

une UX imparfaite pour déclencher une action

La V1 peut vivre avec ça si le sync reste simple.

16. Market research — implémentation à spécifier

Cette partie doit être concrète dans la PRD.

La V1 doit fixer explicitement :

un search API

un nombre borné de résultats par requête

la fréquence

la forme du résumé

la manière de transformer ce résumé en Raw Source Item

Reco V1

5 à 10 résultats max par requête

résumé guidé par Layer 1

sortie = Raw Source Item de type market_research_summary

Sans cela, la qualité dépendra d’arbitrages ad hoc pendant le build.

17. Coûts et optimisation

Les utilisateurs apportent leurs propres clés API.

Principes

batcher fortement l’étape 1 de l’Intelligence Agent

réserver l’étape 2 aux items filtrés

ingestion sans LLM

Intelligence avec modèle Sonnet-class

Drafting avec le meilleur modèle choisi par l’utilisateur

charger l’editorial lens une fois par run

ignorer les items inchangés

caper les créations par run

caper les drafts par jour

logger coût et tokens

Cible coût

Moins de 50$/mois par entreprise au volume baseline.

18. Configuration

La config doit être modifiable hors code.

V1

Source of truth :

fichiers config versionnés

ou DB JSON versionnée

Ce qui doit être configurable

sources actives

scopes de sources

market queries

editorial lens

scoring / thresholds

caps de génération

profils

destinations / surfaces

Ce qui n’est pas source de vérité dans Notion

config technique

thresholds

règles système

Exception possible :

édition des voice profiles via Notion si synchronisée proprement

19. Plan de livraison
Semaines 1–2

schéma Postgres

ingestion Notion

ingestion Linear

ingestion Claap

stockage raw_source_items

logs sync_runs

dédup source ID

validation capacité API Claap

Semaines 3–4

Intelligence Agent étape 1 + étape 2

market research runs

création / enrichissement de Content Opportunities

evidence linking

owner suggestion

sync Notion

Semaines 5–6

Draft Agent

trigger draft via endpoint / mécanisme rapide

fallback statut Notion si nécessaire

chargement des voice profiles

génération draft V1

Market Findings manuel

token usage logging

Semaines 7–8

hardening

retries

idempotence

docs de config

docs d’usage

limites / stop conditions

safety checks

20. Critères de succès

La V1 est réussie si :

Elle produit 10 à 20 Content Opportunities par semaine jugées pertinentes.

Plus de 50% des opportunities sont considérées comme “j’écrirais potentiellement là-dessus”.

Chaque opportunity est clairement reliée à des preuves réelles.

Les drafts sonnent comme la personne.

Ajouter une nouvelle source prend moins d’une journée de dev.

Modifier l’editorial lens prend moins de 10 minutes sans toucher au moteur.

Le système ne publie jamais seul.

Le système ne fuit pas de données sensibles.

Le système n’écrase jamais des edits humains.

21. Ce qu’il faut explicitement couper

Cette V1 ne doit pas contenir :

content team comme opérateur

Signal Feed utilisateur

Theme Cluster comme objet métier

learning layer

agent de stratégie / voice séparé

agent de matching séparé

agent d’idéation séparé

Slack ingestion

LinkedIn scraping

digest agent comme composant cœur

configurable-in-Notion pour la config technique

browsing autonome libre

plus de 3 agents

22. Guideline finale d’implémentation

Construire V1 avec cette philosophie :

utile directement pour les créateurs

centré sur Content Opportunity

create/enrich plutôt que pipeline intermédiaire complexe

biais vers “montrer plus” plutôt que filtrer trop fort

preuves directement attachées aux opportunities

config hors code

Notion simple

pas d’automatisation opaque

pas de sur-scope

Ce n’est pas une content factory.
C’est une machine d’assistance éditoriale, branchée sur la réalité interne et externe d’une entreprise, pour des humains qui publient sous leur propre nom.