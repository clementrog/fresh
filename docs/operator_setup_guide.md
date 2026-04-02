Guide opérateur — Editorial Signal Engine

Ce guide documente la configuration Notion, les variables d'environnement, les commandes CLI et les valeurs de référence nécessaires pour opérer le pipeline.

---

## 1. Prérequis

- PostgreSQL (base de données)
- Node.js + pnpm
- Un token d'intégration Notion avec accès à la page parent
- Clés API pour les connecteurs activés (OpenAI, Claap, Linear, Tavily)

---

## 2. Variables d'environnement

### Obligatoires

| Variable | Description |
|---|---|
| `DATABASE_URL` | Chaîne de connexion PostgreSQL |

### Notion

| Variable | Défaut | Description |
|---|---|---|
| `NOTION_TOKEN` | `""` | Token d'intégration Notion |
| `NOTION_PARENT_PAGE_ID` | `""` | UUID de la page parent (conteneur des bases) |

### LLM

| Variable | Défaut | Description |
|---|---|---|
| `OPENAI_API_KEY` | `""` | Clé API OpenAI |
| `ANTHROPIC_API_KEY` | `""` | Clé API Anthropic |
| `INTELLIGENCE_LLM_PROVIDER` | `"openai"` | Provider pour le pipeline intelligence |
| `INTELLIGENCE_LLM_MODEL` | `"gpt-5.4"` | Modèle pour screening/routing |
| `DRAFT_LLM_PROVIDER` | `"openai"` | Provider pour la génération de drafts (`"openai"`, `"anthropic"`, ou `"claude-cli"`) |
| `DRAFT_LLM_MODEL` | `"gpt-5.4"` / `"claude-opus-4-6"` (cli) | Modèle pour les drafts |
| `CLAUDE_CLI_PATH` | `"claude"` | Chemin vers le binaire Claude Code CLI |
| `CLAUDE_CLI_MAX_BUDGET_USD` | `0.50` | Budget max par appel CLI (USD) |
| `CLAUDE_CLI_TIMEOUT_MS` | `120000` | Timeout du process CLI en ms |
| `LLM_MODEL` | `"gpt-5.4-mini"` | Modèle fallback |
| `LLM_TIMEOUT_MS` | `45000` | Timeout LLM en ms |

### Claude CLI pour les drafts

Draft generation peut utiliser Claude Opus 4.6 via le CLI local au lieu de l'API OpenAI. C'est opt-in — le backend par défaut reste OpenAI.

**Activer :**

```bash
DRAFT_LLM_PROVIDER=claude-cli
# Optionnel — ces défauts conviennent dans la plupart des cas :
# DRAFT_LLM_MODEL=claude-opus-4-6
# CLAUDE_CLI_PATH=claude
# CLAUDE_CLI_MAX_BUDGET_USD=0.50
```

**Prérequis :** le binaire `claude` (Claude Code CLI) doit être installé et authentifié. Au premier appel de draft (pas au démarrage), un preflight vérifie que le binaire existe et que le modèle cible répond. L'app peut donc démarrer normalement et échouer plus tard lors du premier draft. Si le preflight échoue, l'erreur est explicite :

```
Error: Claude CLI preflight failed: binary not found at "claude". Install Claude Code CLI or set CLAUDE_CLI_PATH.
Error: Claude CLI preflight probe failed: model "claude-opus-4-6" may not be supported or flags are incompatible.
```

**Vérifier qu'un draft a bien utilisé Opus 4.6 :** dans le cost ledger, le champ `model` affiche le modèle runtime exact reporté par le CLI (ex. `claude-opus-4-6`) et `mode` affiche `provider`. Le coût enregistré est le coût réel facturé par le CLI, pas une estimation.

**Revenir à OpenAI :** supprimer `DRAFT_LLM_PROVIDER` ou le remettre à `"openai"`. Aucun autre changement nécessaire.

**Scope :** le backend `claude-cli` est strictement limité au step `draft-generation`. Si un autre step tente de l'utiliser (mauvaise config), une erreur de configuration est levée immédiatement.

### Connecteurs

| Variable | Défaut | Description |
|---|---|---|
| `CLAAP_API_KEY` | `""` | Clé API Claap |
| `LINEAR_API_KEY` | `""` | Clé API Linear |
| `TAVILY_API_KEY` | `""` | Clé API Tavily (market research) |

### Général

| Variable | Défaut | Description |
|---|---|---|
| `DEFAULT_COMPANY_SLUG` | `"default"` | Identifiant entreprise |
| `DEFAULT_COMPANY_NAME` | `"Default Company"` | Nom affiché |
| `DEFAULT_TIMEZONE` | `"Europe/Paris"` | Fuseau horaire |
| `HTTP_PORT` | `3000` | Port du serveur HTTP |
| `LOG_LEVEL` | `"info"` | Niveau de log |

---

## 3. Commandes CLI

| Commande | Description |
|---|---|
| `pnpm ingest:run` | Ingère les source items depuis les connecteurs configurés |
| `pnpm market-research:run` | Lance les requêtes de recherche marché |
| `pnpm intelligence:run` | Screening → création/enrichissement d'opportunités |
| `pnpm draft:generate --opportunity-id <ID>` | Génère un draft V1 pour une opportunité |
| `pnpm cleanup:retention` | Supprime les données brutes au-delà de la rétention |
| `pnpm server:start` | Démarre le serveur HTTP |

**Flags communs :**
- `--dry-run` — Exécute sans persister
- `--company <slug>` — Override du company slug

---

## 4. Setup Notion

### 4.1 Création initiale

1. Créer une page Notion qui servira de conteneur
2. Copier son UUID dans `NOTION_PARENT_PAGE_ID`
3. Lancer `pnpm setup:notion`

Le système crée automatiquement 5 bases de données enfants et une page "Editorial Signal Engine Operations Guide".

### 4.2 Vues manuelles à créer

Le système ne crée pas de vues filtrées. L'opérateur doit créer ces vues :

| Vue | Base | Filtre / Tri |
|---|---|---|
| To review | Content Opportunities | Status = "To review" |
| Picked | Content Opportunities | Status = "Selected" |
| Draft ready | Content Opportunities | Status = "V1 generated" |
| Rejected or Archived | Content Opportunities | Status = "Rejected" ou "Archived" |
| Needs review | Linear Review | Decision est vide |
| Approved | Linear Review | Decision = "approve" |
| Rejected | Linear Review | Decision = "reject" |
| Recent | Sync Runs | Tri par "Started at" décroissant |

---

## 5. Schéma des bases Notion

### 5.1 Content Opportunities

| Propriété | Type | Description |
|---|---|---|
| Title | title | Titre de l'opportunité |
| Owner profile | rich_text | Profil assigné |
| Narrative pillar | rich_text | Pilier narratif |
| Angle | rich_text | Angle éditorial |
| Why now | rich_text | Justification de timing |
| What it is about | rich_text | Sujet principal |
| What it is not about | rich_text | Hors-périmètre |
| Source of origin | rich_text | Source d'origine |
| Source URL | rich_text | Lien vers la source |
| Provenance type | rich_text | Type de provenance classifié |
| Suggested format | rich_text | Format de contenu suggéré |
| Hook suggestion 1 | rich_text | Première accroche |
| Hook suggestion 2 | rich_text | Deuxième accroche |
| Format rationale | rich_text | Justification du format |
| V1 draft | rich_text | Draft généré |
| Status | select | Statut workflow |
| Editorial notes | rich_text | Notes de l'opérateur |
| Editorial owner | rich_text | Responsable éditorial |
| How close is this to a draft? | select | Indique si l'opportunité est prête, proche, ou trop tôt |
| What's missing | rich_text | Guidance opérateur (ce qui manque) |
| Evidence count | number | Nombre total d'évidences |
| Primary evidence | rich_text | Extrait de la source principale |
| Supporting evidence count | number | Évidences secondaires |
| Evidence freshness | number | Score de fraîcheur (0-1) |
| Evidence excerpts | rich_text | Tous les extraits consolidés |
| Enrichment log | rich_text | Historique d'enrichissement |
| Selected at | date | Date de sélection |
| Last digest at | date | Dernier digest envoyé |
| Opportunity fingerprint | rich_text | Hash de dédup |
| Request re-evaluation | checkbox | Cocher pour demander une réévaluation |

### 5.2 Profiles

| Propriété | Type | Description |
|---|---|---|
| Profile name | title | Nom du profil |
| Role | rich_text | Type de rôle |
| Language preference | rich_text | Langue préférée |
| Tone summary | rich_text | Résumé du ton |
| Preferred structure | rich_text | Structure de contenu préférée |
| Typical phrases | rich_text | Expressions récurrentes |
| Avoid rules | rich_text | Règles d'évitement |
| Content territories | rich_text | Territoires de contenu |
| Weak-fit territories | rich_text | Territoires hors-cible |
| Sample excerpts | rich_text | Exemples de contenu |
| Last refreshed | date | Dernière mise à jour |
| Profile fingerprint | rich_text | Hash de version |

### 5.3 Sync Runs

| Propriété | Type | Description |
|---|---|---|
| Run date | title | Date d'exécution |
| Source | rich_text | Source ingérée |
| Status | select | Statut de l'exécution |
| Items fetched | number | Items récupérés |
| Items processed | number | Items normalisés |
| Errors | rich_text | Messages d'erreur |
| Notes | rich_text | Notes de l'exécution |
| Run type | rich_text | Type de commande |
| Started at | date | Début |
| Finished at | date | Fin |
| Step-level counts | rich_text | Compteurs par étape (JSON) |
| Warning flags | rich_text | Alertes non-bloquantes |
| Token and cost totals | rich_text | Coûts LLM (JSON) |
| Run fingerprint | rich_text | Hash d'exécution |

### 5.4 Linear Review

| Propriété | Type | Description |
|---|---|---|
| Item title | title | Titre de l'issue/update Linear |
| Classification | select | Toujours "manual-review-needed" pour les items en attente |
| Rationale | rich_text | Justification de la classification LLM |
| Customer visibility | select | shipped / in-progress / internal-only / ambiguous |
| Sensitivity level | select | safe / roadmap-sensitive / pre-shipping / promise-like |
| Evidence strength | number | Score 0-1 de force d'evidence |
| Review note | rich_text | Note automatique ou manuelle |
| Linear link | url | Lien vers l'issue/update Linear |
| Item type | rich_text | "issue" ou "project_update" |
| State | rich_text | État Linear (Done, In Progress, etc.) |
| Team | rich_text | Équipe Linear |
| Priority | number | Priorité Linear (0-4) |
| Labels | rich_text | Labels séparés par virgule |
| Occurred at | date | Date de l'item |
| Decision | select | Vide jusqu'à action opérateur (approve / reject) |
| Review fingerprint | rich_text | Hash de dédup |
| Linear source item id | rich_text | ID interne du source item |

---

## 6. Valeurs de référence

### 6.1 Status (Content Opportunities)

`To review` · `Needs routing` · `To enrich` · `Ready for V1` · `V1 generated` · `Selected` · `V2 in progress` · `Waiting approval` · `Rejected` · `Archived`

### 6.2 How close is this to a draft? (Content Opportunities)

| Valeur Notion | Tier interne | Critères |
|---|---|---|
| Draft now | `ready` | Source + support + angle concret + matériel draftable + pas de claim produit non-backé |
| Good idea — one more input | `promising` | Source + matériel mais angle vague ou support manquant, ou claim produit en cours |
| Too early | `needs-more-proof` | Source, angle, matériel ou evidence insuffisants |

### 6.3 Claim posture

| Valeur | Signification |
|---|---|
| `product-claim` | L'angle porte sur une capacité produit |
| `customer-pain` | L'angle porte sur une douleur client |
| `mixed` | Mélange produit + douleur/réglementaire |
| `insight-only` | Insight marché ou réglementaire pur |

### 6.4 Product backing

| Valeur | Signification |
|---|---|
| `backed-live` | Preuve interne que la fonctionnalité est en production |
| `backed-in-progress` | Fonctionnalité en cours de développement |
| `unbacked` | Aucune preuve interne de backing produit |

### 6.5 Provenance type

| Valeur | Source |
|---|---|
| `market-research` | Recherche marché externe |
| `market-findings` | Findings marché (fichiers markdown) |
| `notion:market-insight` | Insight marché structuré dans Notion |
| `notion:claap-signal` | Signal Claap documenté dans Notion |
| `notion:internal-proof` | Preuve interne produit dans Notion |
| `notion` | Page Notion générique |
| `claap` | Appel Claap direct |
| `linear` | Issue/update Linear (non classifié) |
| `linear:enrich-worthy` | Issue/update Linear classifié comme enrichissable |

### 6.6 notionKind (métadonnée des source items)

| Valeur | Peut être origine | Priorité | Jaccard min |
|---|---|---|---|
| `market-insight` | Oui | 1 | 0.10 |
| `claap-signal` | Oui | 1 | 0.10 |
| `internal-proof` | Non | 1 | 0.10 |
| (absent) | Non | 2 | 0.15 |

### 6.7 Sync Run Status

`running` · `completed` · `failed`

---

## 7. Profils éditoriaux

Fichiers dans `editorial/profiles/` :

| Profil | Fichier |
|---|---|
| Baptiste | `editorial/profiles/baptiste.md` |
| Thomas | `editorial/profiles/thomas.md` |
| Virginie | `editorial/profiles/virginie.md` |
| Quentin | `editorial/profiles/quentin.md` |
| Linc Corporate | `editorial/profiles/linc-corporate.md` |

Chaque fichier contient le ton, la structure préférée, les territoires de contenu et les règles d'évitement.

---

## 8. Configuration des sources

Fichiers JSON dans `config/sources/`. Propriétés communes :

```json
{
  "enabled": true,
  "storeRawText": true,
  "retentionDays": 90,
  "rateLimit": {
    "requestsPerMinute": 30,
    "maxRetries": 3,
    "initialDelayMs": 1000
  }
}
```

### Notion

- `pageAllowlist` — UUIDs de pages à inclure
- `databaseAllowlist` — UUIDs de bases à ingérer
- `excludedDatabaseNames` — Noms de bases à exclure (ex: `"Content Opportunities"`, `"Profiles"`)

### Claap

- `workspaceIds` — IDs de workspaces Claap
- `folderIds` — IDs de dossiers spécifiques

### Linear

- `workspaceIds` — IDs de workspaces Linear
- `includeIssues`, `includeProjectUpdates`, `includeIssueComments` — Toggles d'ingestion

### Market Findings

- `directory` — Chemin vers les fichiers markdown (relatif à la racine)

---

## 9. Séquence d'installation complète

1. Créer la base PostgreSQL, configurer `DATABASE_URL`
2. `pnpm install`
3. `pnpm prisma:migrate:deploy`
4. Créer la page parent Notion, configurer `NOTION_TOKEN` + `NOTION_PARENT_PAGE_ID`
5. Configurer les clés API des connecteurs dans `.env`
6. Créer/éditer les fichiers `config/sources/*.json`
7. Créer/éditer `editorial/doctrine.md`, `editorial/sensitivity-rules.md`, `editorial/profiles/*.md`
8. `pnpm setup:notion` — crée les bases et le guide
9. Créer les 5 vues manuelles dans Notion (section 4.2)
10. Lancer le pipeline : `pnpm ingest:run && pnpm intelligence:run`

---

## 10. Catégories de sensibilité

Utilisées pour la classification de sécurité du contenu :

`client-identifiable` · `payroll-sensitive` · `roadmap-sensitive` · `internal-only` · `recruiting-sensitive` · `financial-sensitive`

---

## 11. Workflow d'édition Notion (re-evaluation)

### Principe

Les opérateurs peuvent modifier certaines propriétés d'une opportunité directement dans Notion, puis demander une réévaluation par Fresh.

### Champs éditables par l'utilisateur

| Propriété Notion | Champ DB | Impact |
|---|---|---|
| Title | `Opportunity.title` | Titre de l'opportunité |
| Angle | `Opportunity.angle` | Affecte le score readiness (angle trop vague = bloquant) |
| Why now | `Opportunity.whyNow` | Contexte temporel |
| What it is about | `Opportunity.whatItIsAbout` | Périmètre du sujet |
| What it is not about | `Opportunity.whatItIsNotAbout` | Exclusions |
| Source URL | `EvidenceReference.sourceUrl` | Affecte directement le readiness (source manquante = bloquant) |
| Editorial notes | `Opportunity.editorialNotes` | Notes libres, utilisées pour la génération de draft |

### Champs système (non éditables par ce workflow)

How close is this to a draft?, What's missing, Evidence count, Evidence excerpts, Enrichment log, V1 draft, Status, Evidence freshness, Primary evidence, Supporting evidence count.

### Workflow

1. L'utilisateur modifie les propriétés éditables dans Notion
2. L'utilisateur coche **Request re-evaluation**
3. L'opérateur exécute `pnpm opportunity:pull-notion-edits`
4. Fresh lit les modifications, persiste en base, recalcule le readiness, sync vers Notion
5. La checkbox est automatiquement décochée après succès
6. En cas d'échec sur un item, la checkbox reste cochée pour retry au prochain run

### Scheduling

Exécuter `pnpm opportunity:pull-notion-edits` **avant** `pnpm intelligence:run` dans le planning quotidien. Tant qu'une demande de réévaluation est en attente, les champs éditables sont protégés : les sync sortants ne les écrasent pas.

### Flags

- `--dry-run` — Découvre les demandes sans rien persister
- `--company <slug>` — Override du company slug

### Vérification du round-trip live

Pour vérifier que le workflow fonctionne de bout en bout contre Notion :

```bash
# 1. Vérifier la connectivité Notion (dry-run, aucune écriture)
pnpm opportunity:pull-notion-edits -- --dry-run

# 2. Vérifier le schema (la checkbox doit apparaître)
pnpm setup:notion

# 3. Test complet : éditer une opportunité dans Notion, cocher la checkbox, puis :
pnpm opportunity:pull-notion-edits

# 4. Vérifier dans Notion : readiness recalculé, checkbox décochée,
#    champs édités préservés

# 5. Vérifier le Sync Run : la ligne dans "Sync Runs" doit montrer
#    le run type "opportunity:pull-notion-edits", status "completed",
#    et aucun warning (ou des warnings explicites pour les rows non résolues)
```

Le script `tests/verify-merge-readiness.sh` inclut un smoke test dry-run automatique (étape 7).

### Demandes non résolues

Si une checkbox est cochée mais aucune opportunité ne correspond dans la base (identifiant Notion ou fingerprint inconnu), la demande est :
- Comptée comme "unresolved" dans les notes du Sync Run (visible dans la liste admin et dans Notion)
- Enregistrée comme warning dans le Sync Run avec les identifiants exacts (visible dans le détail admin et dans le champ "Warning flags" Notion)
- Signalée par un badge orange dans la liste admin des runs
- La checkbox reste cochée pour investigation manuelle

**Attention** : tant que la demande n'est pas résolue, les champs éditables de cette opportunité dans Notion ne sont pas protégés contre les sync sortants. Un `intelligence:run` pourrait écraser les modifications utilisateur.

**Comment remédier :**

1. Ouvrir le Sync Run dans l'admin (`/admin/runs`) — chercher un run `opportunity:pull-notion-edits` avec un badge orange
2. Lire le warning : il contient le `notionPageId` et le `fingerprint` de la row Notion non résolue
3. Ouvrir la row correspondante dans la base "Content Opportunities" de Notion
4. Vérifier le champ "Opportunity fingerprint" — s'il diffère de celui affiché dans le warning, c'est un problème d'identifiant
5. Causes possibles :
   - L'opportunité a été supprimée de la base Postgres (vérifier avec `SELECT * FROM "Opportunity" WHERE "notionPageId" = '...'`)
   - L'opportunité appartient à un autre company (vérifier le `--company` flag utilisé)
   - Le fingerprint Notion a été modifié manuellement (ne jamais éditer ce champ)
6. Corriger la cause, puis relancer `pnpm opportunity:pull-notion-edits`
7. Vérifier que le warning disparaît et que la checkbox est décochée

---

## 12. Linear Review Queue

### Fonctionnement

Pendant `intelligence:run`, chaque item Linear (issue ou project update) est évalué par un LLM selon la doctrine de l'entreprise avant de pouvoir enrichir une opportunité de contenu existante. La classification produit trois résultats possibles :

| Classification | Effet |
|---|---|
| `enrich-worthy` | L'item peut enrichir les opportunités existantes comme avant |
| `ignore` | L'item est du bruit interne (refactor, dette technique, CI/CD) — il est filtré |
| `manual-review-needed` | L'item est ambigu, sensible roadmap, ou pré-shipping — il apparaît dans la queue Linear Review |

### Quand un item apparaît dans la queue

- L'item mentionne des fonctionnalités pas encore annoncées (roadmap-sensitive)
- L'item décrit du travail en cours qui pourrait ne pas être livré tel quel (pre-shipping)
- L'item est ambigu : impossible de déterminer s'il est customer-visible ou interne
- Le LLM n'a pas pu évaluer l'item (fallback conservateur)
- L'évaluation a échoué au niveau de la fonction (fail-closed : tous les items Linear sont retenus)

> **Important** : la queue `Linear Review` n'est pas rétroactive en V1. Elle montre les nouveaux items Linear évalués par cette politique, pas un historique complet des anciens items déjà traités avant son déploiement.

### Actions opérateur

| Action | Propriété Decision | Effet (V1) |
|---|---|---|
| Approuver | `approve` | Observabilité uniquement — l'item n'est PAS automatiquement ré-injecté dans le pipeline |
| Rejeter | `reject` | Observabilité uniquement — l'item reste exclu |
| (vide) | — | En attente de review |

> **Note V1** : La queue est en lecture seule du point de vue du pipeline. Les décisions opérateur ne sont pas encore consommées automatiquement. Un futur `cleanup:linear-review` permettra de réintégrer les items approuvés.

### Propriétés

- **Customer visibility** : `shipped` (déjà live), `in-progress` (en cours), `internal-only` (interne), `ambiguous` (pas clair)
- **Sensitivity level** : `safe` (publiable), `roadmap-sensitive` (révèle des plans), `pre-shipping` (pourrait changer), `promise-like` (ressemble à un engagement)
- **Evidence strength** : Score 0-1 de qualité de l'evidence

### Archivage automatique

Si un item précédemment classifié `manual-review-needed` est reclassifié `enrich-worthy` ou `ignore` lors d'un run ultérieur, sa ligne dans la queue Linear Review est automatiquement archivée.
