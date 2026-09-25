SHELL := /bin/zsh

# Version lives in three files that must agree: package.json, tauri.conf.json and
# Cargo.toml. tauri.conf.json is the one the updater compares against, so drift is
# silent but nasty — the app would either re-offer a version it already runs or
# never offer it. `make version` reports drift; `make set-version-X.Y.Z` fixes it.
VERSION       := $(shell node -p "require('./package.json').version" 2>/dev/null)
CONF_VERSION  := $(shell node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null)
CARGO_VERSION := $(shell awk -F'"' '/^version[[:space:]]*=/{print $$2; exit}' src-tauri/Cargo.toml 2>/dev/null)
TAG           := v$(VERSION)

REPO       := adampeterhiggins/github-monitor
TAP_REPO   := adampeterhiggins/homebrew-tap
APP_NAME   := GitHub Monitor
BUNDLE_DIR := src-tauri/target/universal-apple-darwin/release/bundle
TARBALL    := $(BUNDLE_DIR)/macos/$(APP_NAME).app.tar.gz
KEY_FILE   := .updater/signing.key

# Knobs, matching the ergonomics of the reference Makefiles.
FORCE ?= 0
YES   ?= 0
# PUSH=0 stops after tagging, so you can inspect before anything leaves the machine.
PUSH  ?= 1
# WATCH=0 skips following the CI run.
WATCH ?= 1

.DEFAULT_GOAL := help

.PHONY: help install deps dev check build app clean version keygen secrets \
        check-version ensure-version set-version prepare-release tag-version \
        release release-local verify-release watch runs doctor tap-update

##@ Getting started

help: ## Show the available targets
	@printf "\n\033[1mgithub-monitor\033[0m — version \033[36m$(VERSION)\033[0m\n\n"
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
		/^[a-zA-Z0-9_.%-]+:.*##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\n\033[1mKnobs\033[0m\n"
	@printf "  \033[36mFORCE=1\033[0m                skip the version gate\n"
	@printf "  \033[36mYES=1\033[0m                  accept prompts (non-interactive)\n"
	@printf "  \033[36mPUSH=0\033[0m                 stop after tagging, push nothing\n"
	@printf "  \033[36mWATCH=0\033[0m                do not follow the CI run\n"
	@printf "\n\033[1mExamples\033[0m\n"
	@printf "  make release                 check, gate, bump if needed, commit, tag, push, watch\n"
	@printf "  make release-0.3.0           release exactly 0.3.0\n"
	@printf "  make release YES=1           same, no prompts\n"
	@printf "  make release PUSH=0          rehearse locally, push nothing\n"
	@printf "  make release-local           bump if needed, commit, build and publish from here\n"
	@printf "  make app                     build and install into /Applications\n\n"

install: ## Install npm dependencies
	npm install

deps: ## Make node_modules match package-lock.json (runs npm ci only when it is stale)
	@# A stale install fails typecheck with "Cannot find module" for anything a
	@# merged PR added to package.json since your last npm install. Cheap to
	@# check, so every check and release path goes through here first.
	@if node scripts/check-deps.mjs --quiet; then \
		echo "node_modules matches package-lock.json"; \
	else \
		node scripts/check-deps.mjs || true; \
		echo "--> Running npm ci"; \
		npm ci; \
	fi

dev: ## Run the app in development mode
	npm run tauri dev

check: deps ## Typecheck, run query tests and lint the workflows
	npm run check

doctor: ## Check the release prerequisites are in place
	@printf "\033[1mVersions\033[0m\n"
	@$(MAKE) --no-print-directory version
	@printf "\n\033[1mTooling\033[0m\n"
	@for t in node npm gh cargo rustup; do \
		if command -v $$t >/dev/null 2>&1; then printf "  ok    %s\n" "$$t"; \
		else printf "  MISS  %s\n" "$$t"; fi; \
	done
	@if rustup target list --installed 2>/dev/null | grep -q x86_64-apple-darwin; then \
		printf "  ok    x86_64-apple-darwin target (needed for a universal build)\n"; \
	else \
		printf "  MISS  x86_64-apple-darwin target — run: rustup target add x86_64-apple-darwin\n"; \
	fi
	@printf "\n\033[1mDependencies\033[0m\n"
	@if node scripts/check-deps.mjs --quiet; then \
		printf "  ok    node_modules matches package-lock.json\n"; \
	else \
		printf "  MISS  node_modules is stale — run: make deps\n"; \
	fi
	@printf "\n\033[1mSigning\033[0m\n"
	@if [ -f "$(KEY_FILE)" ]; then printf "  ok    local key at $(KEY_FILE)\n"; \
		else printf "  MISS  no local key — run: make keygen\n"; fi
	@if gh secret list --repo $(REPO) 2>/dev/null | grep -q TAURI_SIGNING_PRIVATE_KEY; then \
		printf "  ok    TAURI_SIGNING_PRIVATE_KEY is set on the repo\n"; \
	else \
		printf "  MISS  repo secret not set — run: make secrets\n"; \
	fi
	@if gh secret list --repo $(REPO) 2>/dev/null | grep -q HOMEBREW_TAP_TOKEN; then \
		printf "  ok    HOMEBREW_TAP_TOKEN is set on the repo\n"; \
	else \
		printf "  MISS  HOMEBREW_TAP_TOKEN not set — fine-grained PAT, contents:write on $(TAP_REPO)\n"; \
	fi
	@printf "\n\033[1mGit\033[0m\n"
	@printf "  branch      %s\n" "$$(git rev-parse --abbrev-ref HEAD)"
	@printf "  latest tag  %s\n" "$$(git tag --sort=-v:refname | head -n 1 || echo '(none)')"
	@if [ -n "$$(git status --porcelain)" ]; then printf "  tree        dirty\n"; else printf "  tree        clean\n"; fi
	@printf "\n"

##@ Building

build: ## Build the signed universal macOS bundle
	@if [ ! -f "$(KEY_FILE)" ]; then \
		echo "No signing key at $(KEY_FILE). Run 'make keygen' first, or the build will"; \
		echo "produce a bundle the app cannot verify as an update."; \
		exit 1; \
	fi
	@TAURI_SIGNING_PRIVATE_KEY="$$(cat $(KEY_FILE))" \
	 TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
	 npm run tauri -- build --target universal-apple-darwin
	@echo ""
	@echo "Artifacts:"
	@ls -1 "$(BUNDLE_DIR)"/macos/*.app.tar.gz "$(BUNDLE_DIR)"/macos/*.sig "$(BUNDLE_DIR)"/dmg/*.dmg 2>/dev/null | sed 's/^/  /'

app: build ## Build and install into /Applications
	@# Replacing a running bundle leaves the old process on deleted files, so quit first.
	@if pgrep -f "/Applications/$(APP_NAME).app" >/dev/null 2>&1; then \
		echo "Quitting the running app…"; \
		osascript -e 'quit app "$(APP_NAME)"' >/dev/null 2>&1 || true; \
		sleep 2; \
	fi
	@rm -rf "/Applications/$(APP_NAME).app"
	@cp -R "$(BUNDLE_DIR)/macos/$(APP_NAME).app" /Applications/
	@echo "Installed /Applications/$(APP_NAME).app ($(VERSION))"
	@INSTALLED="$$(defaults read "/Applications/$(APP_NAME).app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"; \
	if [ "$$INSTALLED" != "$(VERSION)" ]; then \
		echo "Install verification failed: expected $(VERSION), found $$INSTALLED"; \
		exit 1; \
	fi; \
	echo "Verified installed version $$INSTALLED"

clean: ## Remove build output
	rm -rf dist
	rm -rf src-tauri/target/universal-apple-darwin/release/bundle
	rm -f latest.json

##@ Versioning

version: ## Show the version in all three files and flag drift
	@printf "  package.json      %s\n" "$(VERSION)"
	@printf "  tauri.conf.json   %s\n" "$(CONF_VERSION)"
	@printf "  Cargo.toml        %s\n" "$(CARGO_VERSION)"
	@if [ "$(VERSION)" != "$(CONF_VERSION)" ] || [ "$(VERSION)" != "$(CARGO_VERSION)" ]; then \
		printf "\n  \033[31mDRIFT\033[0m — run 'make set-version-$(VERSION)' to bring them into line.\n"; \
		printf "  tauri.conf.json is what the updater compares, so this must be fixed before releasing.\n"; \
		exit 1; \
	else \
		printf "  in step\n"; \
	fi

set-version: ## Set the version everywhere (use set-version-X.Y.Z)
	@echo "Usage: make set-version-0.3.0"
	@exit 2

set-version-%: ## Set an explicit version in all three files
	@node scripts/set-version.mjs "$*"

check-version: check-version-$(VERSION) ## Assert the version is ahead of the latest tag

check-version-%:
	@git rev-parse --git-dir >/dev/null 2>&1
	@CURRENT_TAG="v$*"; \
	CURRENT_TAG_COMMIT="$$(git rev-list -n 1 "$$CURRENT_TAG" 2>/dev/null || true)"; \
	HEAD_COMMIT="$$(git rev-parse HEAD)"; \
	LATEST_TAG="$$(git tag --sort=-v:refname | head -n 1)"; \
	LATEST_VERSION="$${LATEST_TAG#v}"; \
	if [ "$(FORCE)" = "1" ]; then \
		echo "FORCE=1 set; skipping version gate (requested version: $*)"; \
	elif [ -n "$$CURRENT_TAG_COMMIT" ] && [ "$$CURRENT_TAG_COMMIT" = "$$HEAD_COMMIT" ]; then \
		echo "HEAD is already tagged $$CURRENT_TAG; allowing a retry of $*"; \
	elif [ -z "$$LATEST_VERSION" ]; then \
		echo "No existing tags; version gate passed for $*"; \
	else \
		HIGHEST="$$(printf '%s\n%s\n' "$*" "$$LATEST_VERSION" | sort -V | tail -n 1)"; \
		if [ "$*" = "$$LATEST_VERSION" ] || [ "$$HIGHEST" != "$*" ]; then \
			echo "Version gate failed: $* must be greater than the latest tag ($$LATEST_TAG)."; \
			echo "Bump with 'make set-version-X.Y.Z', or pass FORCE=1 to rebuild the same version."; \
			exit 1; \
		fi; \
		echo "Version gate passed: $* > $$LATEST_VERSION"; \
	fi

ensure-version: ## Bump the patch version if it is not ahead of the latest tag
	@git rev-parse --git-dir >/dev/null 2>&1
	@CURRENT_VERSION="$(VERSION)"; \
	CURRENT_TAG="v$$CURRENT_VERSION"; \
	CURRENT_TAG_COMMIT="$$(git rev-list -n 1 "$$CURRENT_TAG" 2>/dev/null || true)"; \
	HEAD_COMMIT="$$(git rev-parse HEAD)"; \
	LATEST_TAG="$$(git tag --sort=-v:refname | head -n 1)"; \
	LATEST_VERSION="$${LATEST_TAG#v}"; \
	if [ "$(FORCE)" = "1" ]; then \
		echo "FORCE=1 set; skipping version gate (current version: $$CURRENT_VERSION)"; \
	elif [ -n "$$CURRENT_TAG_COMMIT" ] && [ "$$CURRENT_TAG_COMMIT" = "$$HEAD_COMMIT" ]; then \
		echo "HEAD is already tagged $$CURRENT_TAG; allowing a retry of $$CURRENT_VERSION"; \
	elif [ -z "$$LATEST_VERSION" ]; then \
		echo "No existing tags; version gate passed for $$CURRENT_VERSION"; \
	else \
		HIGHEST="$$(printf '%s\n%s\n' "$$CURRENT_VERSION" "$$LATEST_VERSION" | sort -V | tail -n 1)"; \
		if [ "$$CURRENT_VERSION" = "$$LATEST_VERSION" ] || [ "$$HIGHEST" != "$$CURRENT_VERSION" ]; then \
			NEXT_VERSION="$$(LATEST_VERSION="$$LATEST_VERSION" node -e 'const p=(process.env.LATEST_VERSION||"").split(".").map(Number); if (p.length < 3 || p.some(Number.isNaN)) process.exit(1); p[2] += 1; process.stdout.write(p.join("."));')"; \
			if [ "$(YES)" = "1" ]; then \
				CONFIRM="Y"; \
			elif [ ! -t 0 ]; then \
				echo "Version gate failed: $$CURRENT_VERSION is not greater than the latest tag ($$LATEST_TAG)."; \
				echo "Run interactively, pass YES=1, bump with 'make set-version-X.Y.Z', or use FORCE=1."; \
				exit 1; \
			else \
				printf "Version $$CURRENT_VERSION is not greater than $$LATEST_TAG. Bump to $$NEXT_VERSION? [Y/n]: "; \
				read -r CONFIRM; \
			fi; \
			if [ -z "$$CONFIRM" ] || [ "$$CONFIRM" = "y" ] || [ "$$CONFIRM" = "Y" ]; then \
				node scripts/set-version.mjs "$$NEXT_VERSION"; \
			else \
				echo "Bump declined. Aborting."; \
				exit 1; \
			fi; \
		else \
			echo "Version gate passed: $$CURRENT_VERSION > $$LATEST_VERSION"; \
		fi; \
	fi

tag-version: ## Tag HEAD with the current version
	@git rev-parse --git-dir >/dev/null 2>&1
	@git tag -f "$(TAG)" HEAD
	@echo "Tagged HEAD as $(TAG)"

##@ Releasing

prepare-release: ## Commit any changes and tag, without pushing
	@$(MAKE) --no-print-directory prepare-release-$(VERSION) FORCE=$(FORCE) YES=$(YES)

prepare-release-%: check-version-%
	@git rev-parse --git-dir >/dev/null 2>&1
	@# The three version files must agree before the tag is cut, since CI hard-fails
	@# on a mismatch and a pushed tag is awkward to retract.
	@CONF="$$(node -p 'require("./src-tauri/tauri.conf.json").version')"; \
	if [ "$$CONF" != "$*" ]; then \
		echo "tauri.conf.json is $$CONF but releasing $*. Run 'make set-version-$*' first."; \
		exit 1; \
	fi
	@if [ -n "$$(git status --porcelain)" ]; then \
		DEFAULT_MSG="chore(release): $*"; \
		INPUT_MSG=""; \
		if [ "$(YES)" = "1" ]; then \
			INPUT_MSG="$$DEFAULT_MSG"; \
		elif [ -t 0 ]; then \
			printf "Working tree is dirty. Commit message [$$DEFAULT_MSG]: "; \
			read -r INPUT_MSG; \
		fi; \
		COMMIT_MSG="$${INPUT_MSG:-$$DEFAULT_MSG}"; \
		git add -A; \
		git commit -m "$$COMMIT_MSG"; \
		echo "Committed: $$COMMIT_MSG"; \
	else \
		echo "Working tree is clean."; \
	fi; \
	git tag -f "v$*" HEAD; \
	echo "Tagged HEAD as v$*"

# Checks run *before* the version is touched. They used to run after the bump,
# so a failing typecheck (a stale node_modules, say) aborted the release and left
# a half-done bump dirtying three files. CHECKED=1 is internal: `release` has
# already run the checks by the time it dispatches to release-%.
CHECKED ?= 0

release: ## Full release: check, gate, bump, commit, tag, push, watch CI
	@$(MAKE) --no-print-directory deps
	@echo "--> Running checks"
	@npm run check
	@$(MAKE) --no-print-directory ensure-version FORCE=$(FORCE) YES=$(YES)
	@VER="$$(node -p 'require("./package.json").version')"; \
	$(MAKE) --no-print-directory release-$$VER CHECKED=1 FORCE=$(FORCE) YES=$(YES) PUSH=$(PUSH) WATCH=$(WATCH)

release-%: ## Release an exact version end to end
	@echo "==> Releasing v$* to $(REPO)"
	@if [ "$(CHECKED)" != "1" ]; then \
		$(MAKE) --no-print-directory deps; \
		echo "--> Running checks"; \
		npm run check; \
	fi
	@CONF="$$(node -p 'require("./src-tauri/tauri.conf.json").version')"; \
	if [ "$$CONF" != "$*" ]; then \
		echo "--> Setting version to $* everywhere"; \
		node scripts/set-version.mjs "$*"; \
	fi
	@echo "--> Committing and tagging"
	@$(MAKE) --no-print-directory prepare-release-$* FORCE=$(FORCE) YES=$(YES)
	@# Each recipe line gets its own shell, so `exit 0` here would only end this
	@# line and make would carry on to the push. The guard therefore has to
	@# *dispatch* rather than bail — this bug pushed a tag once already.
	@if [ "$(PUSH)" = "1" ]; then \
		$(MAKE) --no-print-directory push-release-$* WATCH=$(WATCH); \
	else \
		echo ""; \
		echo "PUSH=0: stopped before pushing. Tag v$* exists locally only."; \
		echo "  push when ready:  git push origin HEAD && git push origin v$*"; \
		echo "  undo the tag:     git tag -d v$*"; \
		echo "  undo the commit:  git reset --mixed HEAD~1"; \
	fi

.PHONY: push-release
push-release-%:
	@echo "--> Pushing branch and tag"
	@git push origin HEAD
	@git push origin "v$*" --force
	@echo "--> CI will build, publish the release and update the manifest"
	@if [ "$(WATCH)" = "1" ] && command -v gh >/dev/null 2>&1; then \
		sleep 6; \
		RUN_ID="$$(gh run list --repo $(REPO) --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)"; \
		if [ -n "$$RUN_ID" ]; then \
			gh run watch "$$RUN_ID" --repo $(REPO) --exit-status || { \
				echo ""; \
				echo "The release run failed. Inspect it with:"; \
				echo "  gh run view $$RUN_ID --repo $(REPO) --log-failed"; \
				exit 1; \
			}; \
			$(MAKE) --no-print-directory verify-release-$*; \
		else \
			echo "Could not find the run; check: gh run list --repo $(REPO)"; \
		fi; \
	else \
		echo "Not watching. Follow with: make watch"; \
	fi

verify-release: ## Check the published manifest matches the local version
	@$(MAKE) --no-print-directory verify-release-$(VERSION)

verify-release-%:
	@echo "--> Verifying the published update manifest"
	@# Checked against the contents API rather than raw.githubusercontent.com.
	@# The app polls raw, but raw caches for minutes after a commit lands, so
	@# gating on it would report a good release as broken. raw is reported below
	@# for information only.
	@TOKEN="$$(gh auth token)"; \
	BODY="$$(gh api "repos/$(REPO)/contents/latest.json?ref=releases" --jq '.content' 2>/dev/null | base64 -d)" || { \
		echo "  no manifest on the releases branch — has a release been published?"; exit 1; }; \
	MV="$$(printf '%s' "$$BODY" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).version))}catch{process.stdout.write("unparseable")}})')"; \
	echo "  manifest on releases branch: $$MV"; \
	if [ "$$MV" != "$*" ]; then \
		echo "  expected $* — the app will not offer this release."; \
		exit 1; \
	fi; \
	AURL="$$(printf '%s' "$$BODY" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).platforms["darwin-aarch64"].url))')"; \
	CODE="$$(curl -s -o /dev/null -w '%{http_code}' -L -H "Authorization: Bearer $$TOKEN" -H "Accept: application/octet-stream" "$$AURL")"; \
	echo "  artifact download: http $$CODE"; \
	if [ "$$CODE" != "200" ]; then echo "  the artifact is not downloadable"; exit 1; fi; \
	RAW="$$(curl -sf -H "Authorization: Bearer $$TOKEN" "https://raw.githubusercontent.com/$(REPO)/releases/latest.json" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).version))}catch{process.stdout.write("unavailable")}})' || true)"; \
	echo "  raw.githubusercontent serves: $$RAW (the app polls this; it lags a few minutes)"; \
	echo "  release v$* is live and installable"

release-local: ## Build, publish and update the manifest from this machine (bypasses CI)
	@$(MAKE) --no-print-directory deps
	@$(MAKE) --no-print-directory version
	@# Checks run before the bump, as in `release`, so a failure never leaves a
	@# half-done bump behind.
	@echo "--> Running checks"
	@npm run check
	@# The gate compares against local tags, so pick up any cut elsewhere (CI, another
	@# machine) first — otherwise it could bump to a version that already exists.
	@git fetch --tags --quiet origin 2>/dev/null || echo "  (could not fetch tags; gating on local tags)"
	@$(MAKE) --no-print-directory ensure-version FORCE=$(FORCE) YES=$(YES)
	@# ensure-version may have bumped the files; commit just those so the tag
	@# lands on a commit carrying the version it names. Pushed with the tag below.
	@VER="$$(node -p 'require("./package.json").version')"; \
	if [ -n "$$(git status --porcelain -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock)" ]; then \
		git commit --quiet -m "chore(release): $$VER" -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock; \
		echo "Committed version bump: chore(release): $$VER"; \
	fi
	@# VERSION is read when make parses the file, so a fresh make is needed to see
	@# the bumped value.
	@$(MAKE) --no-print-directory release-local-publish FORCE=$(FORCE)

.PHONY: release-local-publish
release-local-publish:
	@echo "==> Local release of v$(VERSION) — normally CI does this"
	@$(MAKE) --no-print-directory version
	@$(MAKE) --no-print-directory check-version-$(VERSION) FORCE=$(FORCE)
	@$(MAKE) --no-print-directory build
	@set -e; \
	V="$(VERSION)"; \
	TMP="$$(mktemp -d)"; \
	cp "$(TARBALL)" "$$TMP/github-monitor_$${V}_universal.app.tar.gz"; \
	cp "$(TARBALL).sig" "$$TMP/github-monitor_$${V}_universal.app.tar.gz.sig"; \
	DMG="$$(ls "$(BUNDLE_DIR)"/dmg/*.dmg 2>/dev/null | head -n 1)"; \
	[ -n "$$DMG" ] && cp "$$DMG" "$$TMP/github-monitor_$${V}_universal.dmg" || true; \
	git push origin HEAD; \
	git tag -f "v$$V" HEAD; \
	git push origin "refs/tags/v$$V" --force; \
	if gh release view "v$$V" --repo $(REPO) >/dev/null 2>&1; then \
		gh release upload "v$$V" "$$TMP"/* --repo $(REPO) --clobber; \
	else \
		gh release create "v$$V" "$$TMP"/* --repo $(REPO) --title "v$$V" --generate-notes; \
	fi; \
	GH_TOKEN="$$(gh auth token)" node scripts/build-update-manifest.mjs --tag "v$$V" --out latest.json; \
	$(MAKE) --no-print-directory publish-manifest VERSION_ARG="$$V"; \
	rm -rf "$$TMP"; \
	$(MAKE) --no-print-directory tap-update; \
	$(MAKE) --no-print-directory verify-release-$$V

.PHONY: publish-manifest
publish-manifest: ## Publish ./latest.json to the releases branch
	@set -e; \
	if [ ! -f latest.json ]; then echo "No latest.json — generate it first (see manifest-%)."; exit 1; fi; \
	cp latest.json /tmp/gm-latest.json; \
	BRANCH="$$(git rev-parse --abbrev-ref HEAD)"; \
	VER="$${VERSION_ARG:-$$(node -p 'require("/tmp/gm-latest.json").version')}"; \
	rm -f latest.json; \
	STASH=""; \
	if [ -n "$$(git status --porcelain)" ]; then git stash push -u -m "make publish-manifest" >/dev/null; STASH=1; fi; \
	if git ls-remote --exit-code --heads origin releases >/dev/null 2>&1; then \
		git fetch origin releases >/dev/null 2>&1; \
		git checkout -B releases origin/releases >/dev/null 2>&1; \
	else \
		git checkout --orphan releases >/dev/null 2>&1; \
		git rm -rf . >/dev/null 2>&1 || true; \
	fi; \
	cp /tmp/gm-latest.json latest.json; \
	git add latest.json; \
	if git diff --cached --quiet; then \
		echo "Manifest unchanged; nothing to publish."; \
	else \
		git commit -m "chore(release): manifest for v$$VER" >/dev/null; \
		git push origin releases; \
		echo "Published latest.json ($$VER) to the releases branch"; \
	fi; \
	git checkout "$$BRANCH" >/dev/null 2>&1; \
	if [ -n "$$STASH" ]; then git stash pop >/dev/null 2>&1 || true; fi

manifest-%: ## Generate and publish the manifest for an existing release
	@GH_TOKEN="$$(gh auth token)" node scripts/build-update-manifest.mjs --tag "v$*" --out latest.json
	@$(MAKE) --no-print-directory publish-manifest VERSION_ARG="$*"
	@$(MAKE) --no-print-directory verify-release-$*

tap-update: ## Update the Homebrew tap cask for the current version (CI does this too)
	@set -e; \
	V="$(VERSION)"; \
	DMG="$$(ls "$(BUNDLE_DIR)"/dmg/*.dmg 2>/dev/null | head -n 1)"; \
	if [ -z "$$DMG" ]; then echo "No dmg under $(BUNDLE_DIR)/dmg — run 'make build' first."; exit 1; fi; \
	SHA="$$(shasum -a 256 "$$DMG" | awk '{print $$1}')"; \
	TMP="$$(mktemp -d)"; \
	trap 'rm -rf "$$TMP"' EXIT; \
	gh repo clone $(TAP_REPO) "$$TMP/tap" -- --depth 5 >/dev/null; \
	cd "$$TMP/tap"; \
	sed -i '' -E \
	  -e "s/^  version \".*\"/  version \"$$V\"/" \
	  -e "s/^  sha256 \".*\"/  sha256 \"$$SHA\"/" \
	  Casks/github-monitor.rb; \
	if git diff --quiet; then \
		echo "Cask already current ($$V)."; \
	else \
		git add Casks/github-monitor.rb; \
		git commit -m "github-monitor $$V" >/dev/null; \
		git push; \
		echo "Updated $(TAP_REPO) to $$V (sha256 $$SHA)"; \
	fi

##@ CI and signing

watch: ## Follow the most recent release run
	@gh run watch "$$(gh run list --repo $(REPO) --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')" --repo $(REPO) --exit-status

runs: ## List recent release runs
	@gh run list --repo $(REPO) --workflow Release --limit 10

keygen: ## Generate the updater signing keypair (once, kept out of git)
	@if [ -f "$(KEY_FILE)" ]; then \
		echo "$(KEY_FILE) already exists. Refusing to overwrite it —"; \
		echo "replacing the key would strand every installed copy, which could then"; \
		echo "only be updated by hand."; \
		exit 1; \
	fi
	@mkdir -p .updater
	@npx tauri signer generate -w "$(KEY_FILE)" -p ""
	@echo ""
	@echo "Next: put the public key in src-tauri/tauri.conf.json (plugins.updater.pubkey)"
	@echo "      and run 'make secrets'. Then back up $(KEY_FILE)."

secrets: ## Upload the signing key to the repo's Actions secrets
	@if [ ! -f "$(KEY_FILE)" ]; then echo "No $(KEY_FILE) — run 'make keygen' first."; exit 1; fi
	@gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $(REPO) < "$(KEY_FILE)"
	@gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo $(REPO) --body ""
	@echo "Secrets set on $(REPO)"
