import { store, ActionTypes, evaluateCondition } from "./store.js";

const sceneCache = new Map();
const imageCache = new Map();
const scenePreloadCache = new Map();
let assetsManifest;
let renderVersion = 0;
let isAdvancing = false;
let isTransitioning = false;
let currentBgmId = null;
let audioUnlocked = false;
let activeBackgroundKey = "a";
let currentBackgroundPath = null;
let hasBooted = false;

const bgmAudio = new Audio();
bgmAudio.preload = "auto";

async function loadAssetsManifest() {
  assetsManifest = await fetchJson("./data/assets_manifest.json");
}

async function loadScene(sceneId) {
  if (sceneCache.has(sceneId)) return sceneCache.get(sceneId);

  const data = await fetchJson(`./data/scenes/${sceneId}.json`);
  if (data.id !== sceneId) {
    throw new Error(
      `Scene ID mismatch: requested "${sceneId}", received "${data.id}"`,
    );
  }

  sceneCache.set(sceneId, data);
  return data;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

const el = {
  backgroundA: document.getElementById("background-a"),
  backgroundB: document.getElementById("background-b"),
  spriteLeft: document.getElementById("sprite-left"),
  spriteCenter: document.getElementById("sprite-center"),
  spriteRight: document.getElementById("sprite-right"),
  speakerName: document.getElementById("speaker-name"),
  dialogueText: document.getElementById("dialogue-text"),
  choicesContainer: document.getElementById("choices-container"),
  textBox: document.getElementById("text-box"),
  gameContainer: document.getElementById("game-container"),
  status: document.getElementById("game-status"),
  saveButton: document.getElementById("save-button"),
  loadButton: document.getElementById("load-button"),
  contactLink: document.getElementById("contact-link"),
};

function finishBoot() {
  if (hasBooted) return;
  hasBooted = true;
  el.gameContainer.classList.remove("is-booting");
}

function getBackgroundElements() {
  return activeBackgroundKey === "a"
    ? {
        active: el.backgroundA,
        standby: el.backgroundB,
        nextKey: "b",
      }
    : {
        active: el.backgroundB,
        standby: el.backgroundA,
        nextKey: "a",
      };
}

function preloadImage(src) {
  if (!src) return Promise.resolve(null);
  if (imageCache.has(src)) return imageCache.get(src);

  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";

    img.onload = async () => {
      try {
        if (typeof img.decode === "function") {
          await img.decode();
        }
      } catch {
      }
      resolve(img);
    };

    img.onerror = () => {
      imageCache.delete(src);
      reject(new Error(`Failed to preload image: ${src}`));
    };

    img.src = src;
  });

  imageCache.set(src, promise);
  return promise;
}

async function applyBackground(path) {
  const { active, standby, nextKey } = getBackgroundElements();

  if (!path) {
    active.style.opacity = "0";
    standby.style.opacity = "0";
    standby.style.backgroundImage = "none";
    currentBackgroundPath = null;
    return;
  }

  if (currentBackgroundPath === path) {
    return;
  }

  await preloadImage(path);

  standby.style.backgroundImage = `url("${path}")`;
  standby.style.opacity = "1";
  active.style.opacity = "0";

  activeBackgroundKey = nextKey;
  currentBackgroundPath = path;
}

async function renderBackground(bgId) {
  const path = assetsManifest?.backgrounds?.[bgId];

  if (!path) {
    console.warn(`Background not found: ${bgId}`);
    await applyBackground(null);
    return;
  }

  await applyBackground(path);
}

async function renderSprite(sprite) {
  const spriteNodes = [el.spriteLeft, el.spriteCenter, el.spriteRight];

  spriteNodes.forEach((node) => {
    node.style.backgroundImage = "";
    node.classList.remove("active");
  });

  if (!sprite) return;

  const path = assetsManifest?.characters?.[sprite.character]?.[sprite.emotion];
  if (!path) {
    console.warn("Sprite not found", sprite.character, sprite.emotion);
    return;
  }

  await preloadImage(path);

  const targetEl =
    sprite.position === "left"
      ? el.spriteLeft
      : sprite.position === "right"
        ? el.spriteRight
        : el.spriteCenter;

  targetEl.style.backgroundImage = `url("${path}")`;
  targetEl.classList.add("active");
}

function renderText(textFragments) {
  el.dialogueText.replaceChildren();
  if (!textFragments) return;

  textFragments.forEach((fragment) => {
    const span = document.createElement("span");
    span.textContent = fragment.content;

    if (fragment.style) {
      if (fragment.style.color) span.style.color = fragment.style.color;
      if (fragment.style.fontSize) {
        span.style.fontSize = fragment.style.fontSize;
      }
      if (fragment.style.bold) span.style.fontWeight = "bold";
    }
    span.style.whiteSpace = "pre-line";
    el.dialogueText.appendChild(span);
  });
}

function renderSpeaker(speakerId) {
  el.speakerName.textContent = speakerId ?? "";
  el.speakerName.style.display = speakerId ? "block" : "none";
}

function getChoiceRollKey(state) {
  return `${state.currentSceneId}:${state.currentLineIndex}`;
}

function prepareChoiceRolls(choices, sceneId, lineIndex, state) {
  const key = `${sceneId}:${lineIndex}`;
  const cached = state.rareChoiceRolls[key];
  if (cached) return { key, rolls: cached };

  return {
    key,
    rolls: choices.map((choice) => {
      const probability = choice.probability ?? 1;
      return Math.random() < Math.max(0, Math.min(1, probability));
    }),
  };
}

function getChoiceRolls(choices, state) {
  const key = getChoiceRollKey(state);
  const cached = state.rareChoiceRolls[key];
  return cached ?? choices.map(() => false);
}

function renderChoices(choices, state) {
  el.choicesContainer.replaceChildren();

  if (!choices || choices.length === 0) {
    el.choicesContainer.style.display = "none";
    el.textBox.style.display = "block";
    return;
  }

  el.textBox.style.display = "none";
  el.choicesContainer.style.display = "flex";

  const rolls = getChoiceRolls(choices, state);
  const visibleChoices = choices
    .map((choice, index) => ({ choice, index }))
    .filter(
      ({ choice, index }) =>
        rolls[index] && evaluateCondition(choice.condition, state),
    );

  if (visibleChoices.length === 0) {
    console.error("No choices are available", {
      sceneId: state.currentSceneId,
      lineIndex: state.currentLineIndex,
    });
    showStatus("選択肢を表示できません。シーン設定を確認してね。");
    return;
  }

  visibleChoices.forEach(({ choice, index }) => {
    const button = document.createElement("button");
    const isRare = (choice.probability ?? 1) < 1;

    button.type = "button";
    button.className = isRare
      ? "choice-button choice-button--rare"
      : "choice-button";
    button.textContent = choice.label;

    if (isRare) {
      const sparkle = document.createElement("span");
      sparkle.className = "rare-sparkle";
      sparkle.textContent = "✨";
      sparkle.setAttribute("aria-hidden", "true");
      button.prepend(sparkle);
    }

    button.addEventListener("click", async () => {
      unlockAudio();
      await transitionToScene(choice.next);
    });

    el.choicesContainer.appendChild(button);
  });
}

function renderBgm(bgmConfig) {
  if (!bgmConfig?.id) {
    bgmAudio.pause();
    bgmAudio.currentTime = 0;
    currentBgmId = null;
    return;
  }

  const path = assetsManifest?.bgm?.[bgmConfig.id];
  if (!path) {
    console.warn(`BGM not found: ${bgmConfig.id}`);
    return;
  }

  bgmAudio.loop = bgmConfig.loop ?? true;
  bgmAudio.volume = Math.max(0, Math.min(1, bgmConfig.volume ?? 1));

  if (currentBgmId !== bgmConfig.id) {
    currentBgmId = bgmConfig.id;
    bgmAudio.src = path;
  }

  if (audioUnlocked && bgmAudio.paused) {
    bgmAudio.play().catch((error) => {
      console.warn("BGM playback was blocked", error);
    });
  }
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  renderBgmForCurrentScene();
}

async function renderBgmForCurrentScene() {
  try {
    const scene = await loadScene(store.getState().currentSceneId);
    renderBgm(scene.bgm);
  } catch (error) {
    console.error("Failed to start BGM", error);
  }
}

function getSceneBackgroundPath(scene) {
  return assetsManifest?.backgrounds?.[scene.background] ?? null;
}

function getSpritePath(sprite) {
  if (!sprite) return null;
  return assetsManifest?.characters?.[sprite.character]?.[sprite.emotion] ?? null;
}

function collectSceneAssetPaths(scene) {
  const paths = new Set();

  const bgPath = getSceneBackgroundPath(scene);
  if (bgPath) paths.add(bgPath);

  for (const line of scene.lines ?? []) {
    const spritePath = getSpritePath(line.sprite);
    if (spritePath) paths.add(spritePath);
  }

  return [...paths];
}

function collectLikelyNextSceneIds(scene, state) {
  const nextIds = new Set();

  if (scene.type === "screen" && scene.next) {
    nextIds.add(scene.next);
    return [...nextIds];
  }

  const currentLine = scene.lines?.[state.currentLineIndex];
  if (!currentLine) return [...nextIds];

  if (currentLine.type === "dialogue") {
    if (currentLine.next) {
      nextIds.add(currentLine.next);
    } else {
      const nextLine = scene.lines?.[state.currentLineIndex + 1];
      if (nextLine?.type === "choice") {
        nextLine.choices.forEach((choice) => {
          if (evaluateCondition(choice.condition, state)) {
            nextIds.add(choice.next);
          }
        });
      }
    }
  }

  if (currentLine.type === "choice") {
    currentLine.choices.forEach((choice) => {
      if (evaluateCondition(choice.condition, state)) {
        nextIds.add(choice.next);
      }
    });
  }

  return [...nextIds];
}

async function preloadSceneAssets(sceneId) {
  if (!sceneId) return;
  if (scenePreloadCache.has(sceneId)) return scenePreloadCache.get(sceneId);

  const promise = (async () => {
    const scene = await loadScene(sceneId);
    const paths = collectSceneAssetPaths(scene);
    await Promise.allSettled(paths.map((path) => preloadImage(path)));
  })();

  scenePreloadCache.set(sceneId, promise);
  return promise;
}

async function warmupUpcomingScenes(scene, state) {
  const nextSceneIds = collectLikelyNextSceneIds(scene, state);
  await Promise.allSettled(nextSceneIds.map((sceneId) => preloadSceneAssets(sceneId)));
}

function showScreenMode() {
  el.textBox.style.display = "none";
  el.choicesContainer.style.display = "none";
  [el.spriteLeft, el.spriteCenter, el.spriteRight].forEach((node) => {
    node.classList.remove("active");
  });
}

function showDialogueMode() {
  el.textBox.style.display = "block";
}

function showStatus(message = "") {
  el.status.textContent = message;
  el.status.classList.toggle("active", Boolean(message));
}

async function render(state) {
  const version = ++renderVersion;

  try {
    showStatus("");
    const scene = await loadScene(state.currentSceneId);
    renderContactLink(scene.id);
    if (version !== renderVersion) return;

    if (scene.type === "screen") {
      if (scene.resetsPlaythrough) {
        const before = store.getState();
        store.dispatch({ type: ActionTypes.RESETPLAYTHROUGH });
        if (store.getState() !== before) return;
      }

      await renderBackground(scene.background);
      if (version !== renderVersion) return;
      finishBoot();
      renderBgm(scene.bgm);
      showScreenMode();
      void warmupUpcomingScenes(scene, state);
      return;
    }

    await renderBackground(scene.background);
    if (version !== renderVersion) return;
    finishBoot();
    renderBgm(scene.bgm);

    const line = scene.lines?.[state.currentLineIndex];
    if (!line) {
      showStatus("ここから先のシーンが見つからないよ。");
      return;
    }

    showDialogueMode();

    if (line.type === "dialogue") {
      await renderSprite(line.sprite);
      if (version !== renderVersion) return;
      renderSpeaker(line.speaker);
      renderText(line.text);
      renderChoices(null, state);
      void warmupUpcomingScenes(scene, state);
      return;
    }

    if (line.type === "choice") {
      renderSpeaker(null);
      renderText(null);
      renderChoices(line.choices, state);
      void warmupUpcomingScenes(scene, state);
      return;
    }

    showStatus(`未対応のline typeです: ${line.type}`);
  } catch (error) {
    console.error("Render failed", error);
    showStatus(`ゲームデータを読み込めませんでした: ${error.message}`);
  }
}
 
async function transitionToScene(sceneId) {
  await preloadSceneAssets(sceneId);

  try {
    const nextScene = await loadScene(sceneId);
    const firstLine = nextScene.lines?.[0];
    const choiceRolls =
      firstLine?.type === "choice"
        ? prepareChoiceRolls(firstLine.choices, sceneId, 0, store.getState())
        : null;

    store.dispatch({
      type: ActionTypes.GOTOSCENE,
      payload: { sceneId, choiceRolls },
    });
  } finally {
    isTransitioning = false;
  }
}

async function advanceDialogue() {
  if (isAdvancing) return;

  isAdvancing = true;
  const state = store.getState();

  try {
    const scene = await loadScene(state.currentSceneId);
    if (state.currentSceneId !== store.getState().currentSceneId) return;

    const line = scene.lines?.[state.currentLineIndex];
    if (!line || line.type !== "dialogue") return;

    if (line.next) {
      await transitionToScene(line.next);
    } else {
      const nextLine = scene.lines?.[state.currentLineIndex + 1];
      const choiceRolls =
        nextLine?.type === "choice"
          ? prepareChoiceRolls(
              nextLine.choices,
              state.currentSceneId,
              state.currentLineIndex + 1,
              state,
            )
          : null;

      store.dispatch({
        type: ActionTypes.ADVANCELINE,
        payload: { choiceRolls },
      });
    }
  } catch (error) {
    console.error("Advance failed", error);
    showStatus("進行処理に失敗しますた。");
  } finally {
    isAdvancing = false;
  }
}

el.textBox.addEventListener("click", () => {
  unlockAudio();
  advanceDialogue();
});

el.gameContainer.addEventListener("click", async (event) => {
  if (event.target.closest("button, a")) return;

  unlockAudio();
  const state = store.getState();

  try {
    const scene = await loadScene(state.currentSceneId);
    if (scene.type === "screen" && scene.next) {
      if (scene.resetsPlaythrough) {
        store.dispatch({ type: ActionTypes.RESETPLAYTHROUGH });
      }
      await transitionToScene(scene.next);
    }
  } catch (error) {
    console.error("Screen transition failed", error);
    showStatus("画面遷移に失敗しますた。");
  }
});

document.addEventListener("keydown", (event) => {
  if (!["Enter", " ", "ArrowRight"].includes(event.key)) return;
  if (event.target instanceof HTMLButtonElement) return;

  event.preventDefault();
  unlockAudio();
  advanceDialogue();
});

el.saveButton.addEventListener("click", () => {
  showStatus(store.save() ? "保存しました。" : "保存に失敗しました。");
});

el.loadButton.addEventListener("click", () => {
  showStatus(store.load() ? "読み込みました。" : "セーブデータがありません。");
});

store.subscribe((state) => {
  render(state);
});

function renderContactLink(sceneId) {
  el.contactLink.hidden = sceneId !== "ending";
}

async function init() {
  try {
    await loadAssetsManifest();
    await preloadSceneAssets("title");
    await preloadSceneAssets("scene001");
    await render(store.getState());
  } catch (error) {
    console.error("Initialization failed", error);
    showStatus(`初期化に失敗しますた: ${error.message}`);
  }
}

init();