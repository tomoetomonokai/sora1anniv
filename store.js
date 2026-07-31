const initialState = {
  currentSceneId: "title",
  currentLineIndex: 0,
  flags: {},
  variables: {},
  history: [],
  seenChoices: {},
  rareChoiceRolls: {},
};

const ActionTypes = {
  GOTOSCENE: "GOTOSCENE",
  ADVANCELINE: "ADVANCELINE",
  SETFLAG: "SETFLAG",
  SETVARIABLE: "SETVARIABLE",
  LOADSTATE: "LOADSTATE",
  RESETPLAYTHROUGH: "RESETPLAYTHROUGH",
};

function withChoiceRolls(state, choiceRolls) {
  if (!choiceRolls || state.rareChoiceRolls[choiceRolls.key]) {
    return state.rareChoiceRolls;
  }

  return {
    ...state.rareChoiceRolls,
    [choiceRolls.key]: choiceRolls.rolls,
  };
}

function reducer(state, action) {
  switch (action.type) {
    case ActionTypes.GOTOSCENE:
      return {
        ...state,
        currentSceneId: action.payload.sceneId,
        currentLineIndex: 0,
        rareChoiceRolls: withChoiceRolls(state, action.payload.choiceRolls),
        history: [
          ...state.history,
          { sceneId: action.payload.sceneId, lineIndex: 0 },
        ],
      };

    case ActionTypes.ADVANCELINE: {
      const nextIndex = state.currentLineIndex + 1;
      return {
        ...state,
        currentLineIndex: nextIndex,
        rareChoiceRolls: withChoiceRolls(state, action.payload?.choiceRolls),
        history: [
          ...state.history,
          { sceneId: state.currentSceneId, lineIndex: nextIndex },
        ],
      };
    }

    case ActionTypes.SETFLAG:
      return {
        ...state,
        flags: {
          ...state.flags,
          [action.payload.key]: action.payload.value,
        },
      };

    case ActionTypes.SETVARIABLE:
      return {
        ...state,
        variables: {
          ...state.variables,
          [action.payload.key]: action.payload.value,
        },
      };

    case ActionTypes.LOADSTATE:
      return {
        ...initialState,
        ...action.payload,
        flags: action.payload.flags ?? {},
        variables: action.payload.variables ?? {},
        history: action.payload.history ?? [],
        seenChoices: action.payload.seenChoices ?? {},
        rareChoiceRolls: action.payload.rareChoiceRolls ?? {},
      };

    case ActionTypes.RESETPLAYTHROUGH: {
      const isAlreadyClean =
        Object.keys(state.flags).length === 0 &&
        Object.keys(state.variables).length === 0 &&
        Object.keys(state.seenChoices).length === 0 &&
        Object.keys(state.rareChoiceRolls).length === 0;

      if (isAlreadyClean) return state;

      return {
        ...state,
        flags: {},
        variables: {},
        seenChoices: {},
        rareChoiceRolls: {},
        history: [],
      };
    }

    default:
      return state;
  }
}

class Store {
  constructor(reducer, initialState) {
    this.reducer = reducer;
    this.state = initialState;
    this.listeners = [];
  }

  getState() {
    return this.state;
  }

  dispatch(action) {
    const nextState = this.reducer(this.state, action);
    const changed = nextState !== this.state;
    this.state = nextState;

    if (changed) this.notify();
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  notify() {
    this.listeners.forEach((listener) => listener(this.state));
  }

  save(slot = "default") {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      state: this.state,
    };

    try {
      localStorage.setItem(`vn-save-${slot}`, JSON.stringify(payload));
      return true;
    } catch (error) {
      console.error("Save failed", error);
      return false;
    }
  }

  load(slot = "default") {
    try {
      const raw = localStorage.getItem(`vn-save-${slot}`);
      if (!raw) return false;

      const payload = JSON.parse(raw);
      if (
        payload?.version !== 1 ||
        !payload.state ||
        typeof payload.state.currentSceneId !== "string"
      ) {
        return false;
      }

      this.dispatch({
        type: ActionTypes.LOADSTATE,
        payload: payload.state,
      });
      return true;
    } catch (error) {
      console.error("Load failed", error);
      return false;
    }
  }
}

function getValueByPath(state, path) {
  const [root, key] = String(path).split(".");

  if (!key || !["flags", "variables"].includes(root)) {
    return undefined;
  }

  return state[root]?.[key];
}

function compareCondition(actual, operator, expected) {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && actual <= expected;
    case "exists":
      return actual !== undefined;
    default:
      return false;
  }
}

function evaluateCondition(condition, state) {
  if (!condition) return true;

  if (Array.isArray(condition.all)) {
    return condition.all.every((item) => evaluateCondition(item, state));
  }

  if (Array.isArray(condition.any)) {
    return condition.any.some((item) => evaluateCondition(item, state));
  }

  if (condition.not) {
    return !evaluateCondition(condition.not, state);
  }

  if (!condition.path || !condition.op) {
    console.warn("Invalid condition", condition);
    return false;
  }

  return compareCondition(
    getValueByPath(state, condition.path),
    condition.op,
    condition.value,
  );
}

const store = new Store(reducer, initialState);

export {
  store,
  Store,
  reducer,
  initialState,
  ActionTypes,
  evaluateCondition,
};