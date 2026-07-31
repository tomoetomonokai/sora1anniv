import { store, ActionTypes, evaluateCondition } from "./store.js";

const sceneCache = new Map();
let assetsManifest;
let renderVersion = 0;
let isAdvancing = false;
let isTransitioning = false;
let currentBgmId = null;
let audioUnlocked = false;

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
  background: document.getElementById("background"),
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

function renderBackground(bgId) {
  const path = assetsManifest?.backgrounds?.[bgId];

  if (!path) {
    console.warn(`Background not found: ${bgId}`);
    el.background.style.backgroundImage = "none";
    return;
  }

  el.background.style.backgroundImage = `url("${path}")`;
}

function renderSprite(sprite) {
  [el.spriteLeft, el.spriteCenter, el.spriteRight].forEach((node) => {
    node.style.backgroundImage = "";
    node.classList.remove("active");
  });

  if (!sprite) return;

  const path = assetsManifest?.characters?.[sprite.character]?.[sprite.emotion];
  if (!path) {
    console.warn("Sprite not found", sprite.character, sprite.emotion);
    return;
  }

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
      renderBackground(scene.background);
      renderBgm(scene.bgm);
      showScreenMode();
      return;
    }

    renderBackground(scene.background);
    renderBgm(scene.bgm);

    const line = scene.lines?.[state.currentLineIndex];
    if (!line) {
      showStatus("ここから先のシーンが見つからないよ。");
      return;
    }

    showDialogueMode();

    if (line.type === "dialogue") {
      renderSprite(line.sprite);
      renderSpeaker(line.speaker);
      renderText(line.text);
      renderChoices(null, state);
      return;
    }

    if (line.type === "choice") {
      renderSpeaker(null);
      renderText(null);
      renderChoices(line.choices, state);
      return;
    }

    showStatus(`未対応のline typeです: ${line.type}`);
  } catch (error) {
    console.error("Render failed", error);
    showStatus(`ゲームデータを読み込めませんでした: ${error.message}`);
  }
}
 
async function transitionToScene(sceneId) {
  if (isTransitioning) return;
  isTransitioning = true;

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
    await render(store.getState());
  } catch (error) {
    console.error("Initialization failed", error);
    showStatus(`初期化に失敗しますた: ${error.message}`);
  }
}

init();