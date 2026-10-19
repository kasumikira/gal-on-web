export class TJSArray {
  constructor(vm, values = []) {
    if (typeof vm?.collection !== "function")
      throw new Error("TJSArray requires a TJS runtime");
    return vm.collection(1, Array.from(values).entries());
  }
}

export class TJSDictionary {
  constructor(vm, entries = []) {
    if (typeof vm?.collection !== "function")
      throw new Error("TJSDictionary requires a TJS runtime");
    return vm.collection(2, entries);
  }
}
