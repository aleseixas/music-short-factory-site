(function () {
  "use strict";

  document.documentElement.classList.add("js");

  const toggle = document.querySelector(".nav-toggle");
  const navigation = document.querySelector(".site-nav");

  if (toggle && navigation) {
    const closeNavigation = function () {
      toggle.setAttribute("aria-expanded", "false");
      navigation.dataset.open = "false";
    };

    toggle.addEventListener("click", function () {
      const isOpen = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!isOpen));
      navigation.dataset.open = String(!isOpen);
    });

    navigation.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        closeNavigation();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        closeNavigation();
        toggle.focus();
      }
    });

    document.addEventListener("click", function (event) {
      if (!navigation.contains(event.target) && !toggle.contains(event.target)) {
        closeNavigation();
      }
    });
  }

  document.querySelectorAll("[data-year]").forEach(function (node) {
    node.textContent = String(new Date().getFullYear());
  });
})();
