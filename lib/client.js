// dsh-file-transfer — client half.
//
// Hand-written CJS module bundle, loaded by the Web shell's __ModuleLoader__.
// No build step, no bundler, no third-party runtime beyond the `react` module
// the shell already provides.
//
// Two action buttons:
//
//   sidebar.right.tab.document.actions  -> ⬇ download the previewed file
//   sidebar.right.tab.files.actions     -> ⬆ upload into the workspace root
//
// Both slots hand the control an owner object carrying `absolutePath`, so the
// buttons never guess a path. The download button probes the route with HEAD
// first, so a refused or missing file surfaces as a message instead of a
// mystery download.
window.__ModuleLoader__.load({
  id: "dsh-file-transfer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var DOWNLOAD_PATH = "/api/dsh-file-transfer/download";
    var UPLOAD_PATH = "/api/dsh-file-transfer/upload";

    var STRINGS = {
      en: {
        download: "Download",
        downloadBusy: "Downloading…",
        upload: "Upload",
        uploadBusy: "Uploading…",
        uploaded: "Uploaded",
        failed: "Failed",
      },
      zh: {
        download: "下载",
        downloadBusy: "下载中…",
        upload: "上传",
        uploadBusy: "上传中…",
        uploaded: "已上传",
        failed: "失败",
      },
    };

    var language =
      (typeof navigator !== "undefined" && navigator.language) || "en";
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
        maxWidth: 240,
      };
    }

    /** Read the resolved absolute path a sidebar action slot hands its controls. */
    function ownerPath(props) {
      var value = props && props.absolutePath;
      return typeof value === "string" && value.length > 0 ? value : "";
    }

    /** Download the previewed file as an attachment. */
    function DownloadAction(props) {
      var path = ownerPath(props);
      var [phase, setPhase] = React.useState("idle");
      var [note, setNote] = React.useState("");
      if (path === "") return null;

      var parseError = (body, status) => {
        if (body && body.error && (body.error.message || body.error.code)) {
          return body.error.message || body.error.code;
        }
        return "HTTP " + status;
      };

      var onClick = async () => {
        var url = DOWNLOAD_PATH + "?path=" + encodeURIComponent(path);
        setPhase("busy");
        setNote("");
        try {
          // Probe first: a 403/404/416 answer becomes visible text rather than
          // a silent browser download of a JSON error page.
          var probe = await fetch(url, {
            method: "HEAD",
            credentials: "same-origin",
          });
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
          var anchor = document.createElement("a");
          anchor.href = url;
          anchor.rel = "noopener";
          anchor.style.display = "none";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
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
            title: busy ? text.downloadBusy : text.download + ": " + path,
            disabled: busy,
            style: Object.assign({}, buttonStyle, { opacity: busy ? 0.6 : 1 }),
            onClick: onClick,
          },
          busy ? "⏳ " + text.downloadBusy : "⬇ " + text.download
        ),
        note
          ? React.createElement(
              "span",
              {
                "data-file-transfer-note": phase,
                style: noteStyle(phase),
                title: note,
              },
              note
            )
          : null
      );
    }

    /** Upload one or more picked files into the directory a sidebar action offers. */
    function UploadAction(props) {
      var dir = ownerPath(props);
      var [busy, setBusy] = React.useState(false);
      var [note, setNote] = React.useState("");
      var [noteKind, setNoteKind] = React.useState("info");
      var inputRef = React.useRef(null);
      if (dir === "") return null;

      var pick = () => {
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
      };

      var onFiles = async (event) => {
        var files = Array.from(event.target.files || []);
        event.target.value = "";
        if (files.length === 0) return;
        setBusy(true);
        setNote("");
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
              var message =
                body && body.error
                  ? body.error.message || body.error.code
                  : "HTTP " + response.status;
              failures.push((file.name || "file") + ": " + message);
              continue;
            }
            uploaded.push(body.value && body.value.name ? body.value.name : file.name);
          } catch (error) {
            failures.push(
              (file.name || "file") + ": " + String((error && error.message) || error)
            );
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
      };

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            "data-file-transfer": "upload",
            title: busy ? text.uploadBusy : text.upload + " → " + dir,
            disabled: busy,
            style: Object.assign({}, buttonStyle, { opacity: busy ? 0.6 : 1 }),
            onClick: pick,
          },
          busy ? "⏳ " + text.uploadBusy : "⬆ " + text.upload
        ),
        React.createElement("input", {
          ref: inputRef,
          type: "file",
          multiple: true,
          // The picker input is positioned off-screen rather than display:none
          // so showPicker() still works; keep it out of the accessibility tree
          // and the tab order instead.
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
          onChange: onFiles,
        }),
        note
          ? React.createElement(
              "span",
              {
                "data-file-transfer-note": noteKind,
                style: noteStyle(noteKind),
                title: note,
              },
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
                  id: "dsh-file-transfer-upload",
                  order: 10,
                },
                UploadAction
              )
            ),
          "file-transfer: upload action"
        );
      },
    };
  },
});
