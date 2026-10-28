

function markNativeWindow() {
  document.documentElement.classList.add("is-native-window");
}


if (window.pywebview?.api) markNativeWindow();
else window.addEventListener("pywebviewready", markNativeWindow);
