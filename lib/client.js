// dsh-file-transfer — client half.
//
// Hand-written CJS module bundle, loaded by the Web shell's __ModuleLoader__.
// No build step, no bundler, no third-party runtime beyond the `react` module
// the shell already provides.
//
//   sidebar.right.tab.document.actions  -> ⬇ download the previewed file
//   sidebar.right.tab.files.actions     -> ⬆ upload + 🗜 ZIP for the file tree
//
// The tree actions track which folder you are working in by listening to the
// file tree's own DOM, which already exposes absolute paths:
//
//   <li data-files-entry="directory|file" data-files-path="/abs/...">
//
// Clicking a folder makes it the upload/archive target; clicking a file targets
// its parent. Dropping files onto a row targets that row's folder, and dropping
// onto empty space targets the workspace root. Nothing here re-implements the
// tree — it reads attributes the shipped file browser already writes.
window.__ModuleLoader__.load({
  id: "dsh-file-transfer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var DOWNLOAD_PATH = "/api/dsh-file-transfer/download";
    var UPLOAD_PATH = "/api/dsh-file-transfer/upload";
    var ARCHIVE_PATH = "/api/dsh-file-transfer/archive";

    var STRINGS = {
      en: {
        download: "Download",
        downloading: "Downloading…",
        upload: "Upload",
        uploading: "Uploading…",
        dropTo: "Drop into",
        zip: "ZIP",
        uploaded: "Uploaded",
      },
      zh: {
        download: "下载",
        downloading: "下载中…",
        upload: "上传",
        uploading: "上传中…",
        dropTo: "传到",
        zip: "打包",
        uploaded: "已上传",
      },
    };

    var language = (typeof navigator !== "undefined" && navigator.language) || "en";
    var text = language.toLowerCase().indexOf("zh") === 0 ? STRINGS.zh : STRINGS.en;

    function token(name, fallback) {
      return "var(" + name + ", " + fallback + ")";
    }

    var buttonStyle = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      height: 24,
      padding: "0 8px",
      borderRadius: 6,
      border: "1px solid " + token("--dsw-alias-border-l2-darkmode-thin", "#333"),
      background: "transparent",
      color: token("--dsw-alias-label-secondary", "#888"),
      cursor: "pointer",
      fontSize: 12,
      lineHeight: 1,
      flex: "none",
      whiteSpace: "nowrap",
    };

    function noteStyle(kind) {
      return {
        fontSize: 11,
        marginLeft: 6,
        color:
          kind === "error"
            ? token("--dsw-alias-state-error-primary", "#e5484d")
            : token("--dsw-alias-label-tertiary", "#999"),
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: 220,
      };
    }

    /** Read the resolved absolute path a sidebar action slot hands its controls. */
    function ownerPath(props) {
      var value = props && props.absolutePath;
      return typeof value === "string" && value.length > 0 ? value : "";
    }

    function trimTrailing(p) {
      return String(p || "").replace(/[/\\]+$/, "");
    }

    function baseName(p) {
      var value = trimTrailing(p);
      var index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
      return index >= 0 ? value.slice(index + 1) : value;
    }

    function parentOf(p) {
      var value = trimTrailing(p);
      var index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
      return index > 0 ? value.slice(0, index) : "";
    }

    // ── the shipped file tree already publishes absolute paths ────────────

    function panelOf(element) {
      return element && element.closest ? element.closest("[data-files-root]") : null;
    }

    function rowOf(target) {
      return target && target.closest ? target.closest("[data-files-entry]") : null;
    }

    /** The folder a row stands for: a directory itself, or a file's parent. */
    function dirOfRow(row, fallback) {
      if (!row) return fallback;
      var path = row.getAttribute("data-files-path");
      if (!path) return fallback;
      if (row.getAttribute("data-files-entry") === "directory") return path;
      return parentOf(path) || fallback;
    }

    function parseError(body, status) {
      if (body && body.error && (body.error.message || body.error.code)) {
        return body.error.message || body.error.code;
      }
      return "HTTP " + status;
    }

    function triggerDownload(url) {
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    /** Download the previewed file as an attachment. */
    function DownloadAction(props) {
      var path = ownerPath(props);
      var [phase, setPhase] = React.useState("idle");
      var [note, setNote] = React.useState("");
      if (path === "") return null;

      var onClick = async () => {
        var url = DOWNLOAD_PATH + "?path=" + encodeURIComponent(path);
        setPhase("busy");
        setNote("");
        try {
          // Probe first: a 403/404/416 answer becomes visible text rather than
          // a silent browser download of a JSON error page.
          var probe = await fetch(url, { method: "HEAD", credentials: "same-origin" });
          if (!probe.ok) {
            var detail = "HTTP " + probe.status;
            try {
              detail = parseError(await probe.json(), probe.status);
            } catch (_error) {
              /* keep the status line */
            }
            setPhase("error");
            setNote(detail);
            return;
          }
          triggerDownload(url);
          setPhase("idle");
        } catch (error) {
          setPhase("error");
          setNote(String((error && error.message) || error));
        }
      };

      var busy = phase === "busy";
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            "data-file-transfer": "download",
            title: (busy ? text.downloading : text.download) + ": " + path,
            disabled: busy,
            style: Object.assign({}, buttonStyle, { opacity: busy ? 0.6 : 1 }),
            onClick: onClick,
          },
          busy ? "⏳ " + text.downloading : "⬇ " + text.download
        ),
        note
          ? React.createElement(
              "span",
              { "data-file-transfer-note": phase, style: noteStyle(phase), title: note },
              note
            )
          : null
      );
    }

    /** Upload and archive controls for the file tree, sharing one target folder. */
    function TreeActions(props) {
      var root = ownerPath(props);
      var [target, setTarget] = React.useState(root);
      var [busy, setBusy] = React.useState(false);
      var [note, setNote] = React.useState("");
      var [noteKind, setNoteKind] = React.useState("info");
      var [dropping, setDropping] = React.useState(false);
      var buttonRef = React.useRef(null);
      var inputRef = React.useRef(null);
      var rootRef = React.useRef(root);
      var targetRef = React.useRef(target);
      rootRef.current = root;
      targetRef.current = target;

      React.useEffect(() => {
        setTarget(root);
      }, [root]);

      var upload = React.useCallback(async (files, dir) => {
        if (!files || files.length === 0) return;
        setBusy(true);
        setNote("");
        setNoteKind("info");
        var uploaded = [];
        var failures = [];
        for (var index = 0; index < files.length; index += 1) {
          var file = files[index];
          var url =
            UPLOAD_PATH +
            "?dir=" +
            encodeURIComponent(dir) +
            "&name=" +
            encodeURIComponent(file.name || "upload.bin");
          try {
            var response = await fetch(url, {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/octet-stream" },
              body: file,
            });
            var body = null;
            try {
              body = await response.json();
            } catch (_error) {
              body = null;
            }
            if (!response.ok || !body || body.ok !== true) {
              var message = body && body.error ? parseError(body, response.status) : "HTTP " + response.status;
              failures.push((file.name || "file") + ": " + message);
              continue;
            }
            uploaded.push((body.value && body.value.name) || file.name);
          } catch (error) {
            failures.push((file.name || "file") + ": " + String((error && error.message) || error));
          }
        }
        setBusy(false);
        if (failures.length > 0) {
          setNoteKind("error");
          setNote(failures.join("; "));
        } else {
          setNoteKind("info");
          setNote(text.uploaded + " " + uploaded.length);
        }
        // Best effort: the tree watches the workspace, but a manual reload
        // makes a freshly written folder show up even when that watch is idle.
        try {
          var panel = panelOf(buttonRef.current);
          var reload = panel && panel.querySelector("[data-files-reload]");
          if (reload) reload.click();
        } catch (_error) {
          /* refresh is cosmetic */
        }
      }, []);

      // Track the current folder and accept drops, reading only attributes the
      // shipped file tree already renders.
      React.useEffect(() => {
        var host = buttonRef.current;
        if (!host) return undefined;
        var panel = panelOf(host);
        if (!panel) return undefined;
        var body = panel.querySelector("[data-files-body]");
        if (!body) return undefined;

        var marked = null;
        var clearMark = () => {
          if (marked === null) return;
          marked.style.outline = "";
          marked.style.outlineOffset = "";
          marked = null;
        };
        var mark = (row) => {
          if (marked === row) return;
          clearMark();
          if (row === null) return;
          row.style.outline = "1px dashed " + token("--dsw-alias-state-info-primary", "#4dabf7");
          row.style.outlineOffset = "-1px";
          marked = row;
        };
        var carriesFiles = (event) => {
          var types = event.dataTransfer && event.dataTransfer.types;
          return Boolean(types) && Array.prototype.indexOf.call(types, "Files") !== -1;
        };

        var onDragOver = (event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          var row = rowOf(event.target);
          mark(row);
          var dir = dirOfRow(row, rootRef.current);
          if (dir !== targetRef.current) setTarget(dir);
          setDropping(true);
        };
        var onDragLeave = (event) => {
          if (event.relatedTarget && body.contains(event.relatedTarget)) return;
          clearMark();
          setDropping(false);
        };
        var onDrop = (event) => {
          if (!event.dataTransfer) return;
          var files = Array.from(event.dataTransfer.files || []);
          event.preventDefault();
          clearMark();
          setDropping(false);
          if (files.length === 0) return;
          upload(files, dirOfRow(rowOf(event.target), rootRef.current));
        };
        var onClick = (event) => {
          var row = rowOf(event.target);
          if (!row) return;
          var dir = dirOfRow(row, rootRef.current);
          if (dir !== targetRef.current) setTarget(dir);
        };

        body.addEventListener("dragover", onDragOver);
        body.addEventListener("dragleave", onDragLeave);
        body.addEventListener("drop", onDrop);
        body.addEventListener("click", onClick, true);
        return () => {
          body.removeEventListener("dragover", onDragOver);
          body.removeEventListener("dragleave", onDragLeave);
          body.removeEventListener("drop", onDrop);
          body.removeEventListener("click", onClick, true);
          clearMark();
        };
      }, [upload]);

      if (root === "") return null;

      var targetLabel = baseName(target) || target;
      var atRoot = target === root;
      var uploadLabel = dropping
        ? "⬇ " + text.dropTo + " " + targetLabel
        : busy
          ? "⏳ " + text.uploading
          : "⬆ " + text.upload;

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            ref: buttonRef,
            type: "button",
            "data-file-transfer": "upload",
            "data-file-transfer-target": target,
            title: text.upload + " → " + target,
            disabled: busy,
            style: Object.assign({}, buttonStyle, {
              opacity: busy ? 0.6 : 1,
              borderStyle: dropping ? "dashed" : "solid",
              color: dropping ? token("--dsw-alias-state-info-primary", "#4dabf7") : buttonStyle.color,
            }),
            onClick: () => {
              var input = inputRef.current;
              if (!input) return;
              input.value = "";
              if (typeof input.showPicker === "function") {
                try {
                  input.showPicker();
                  return;
                } catch (_error) {
                  /* fall through to click() */
                }
              }
              input.click();
            },
          },
          uploadLabel
        ),
        atRoot
          ? null
          : React.createElement(
              "span",
              {
                "data-file-transfer-target-label": true,
                title: target,
                style: Object.assign({}, noteStyle("info"), { maxWidth: 120 }),
              },
              targetLabel
            ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-file-transfer": "archive",
            title: text.zip + " → " + target,
            style: Object.assign({}, buttonStyle, { marginLeft: 4 }),
            onClick: () => {
              triggerDownload(ARCHIVE_PATH + "?path=" + encodeURIComponent(target));
            },
          },
          "🗜 " + text.zip
        ),
        React.createElement("input", {
          ref: inputRef,
          type: "file",
          multiple: true,
          "aria-hidden": "true",
          tabIndex: -1,
          style: {
            position: "fixed",
            left: "-9999px",
            top: "-9999px",
            width: 1,
            height: 1,
            opacity: 0,
          },
          onChange: (event) => {
            var files = Array.from(event.target.files || []);
            event.target.value = "";
            upload(files, targetRef.current);
          },
        }),
        note
          ? React.createElement(
              "span",
              { "data-file-transfer-note": noteKind, style: noteStyle(noteKind), title: note },
              note
            )
          : null
      );
    }

    return {
      name: "dsh-file-transfer",
      inject: ["slots"],
      apply(ctx) {
        var slots = ctx.get("slots");
        if (!slots) return;

        ctx.effect(
          () =>
            slots.inject("sidebar.right.tab.document.actions", () =>
              slots.register(
                {
                  name: "sidebar.right.tab.document.actions",
                  id: "dsh-file-transfer-download",
                  order: 10,
                },
                DownloadAction
              )
            ),
          "file-transfer: download action"
        );

        ctx.effect(
          () =>
            slots.inject("sidebar.right.tab.files.actions", () =>
              slots.register(
                {
                  name: "sidebar.right.tab.files.actions",
                  id: "dsh-file-transfer-tree",
                  order: 10,
                },
                TreeActions
              )
            ),
          "file-transfer: tree actions"
        );
      },
    };
  },
});
