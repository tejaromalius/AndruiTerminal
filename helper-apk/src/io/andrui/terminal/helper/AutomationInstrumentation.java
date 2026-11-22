package io.andrui.terminal.helper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Base64;
import android.util.SparseArray;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.xpath.XPathConstants;
import javax.xml.xpath.XPathFactory;
import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;

/** Device-local instrumentation transport. No host shell or general device shell endpoint. */
public final class AutomationInstrumentation extends Instrumentation {
    private static final int MAX_BODY = 1024 * 1024;
    // Idle keep-alive sockets hold a worker thread; keep that window short.
    private static final int KEEP_ALIVE_IDLE_MS = 2000;
    private static final int KEEP_ALIVE_MAX_REQUESTS = 100;
    private static final int FLAG_SECURE = 0x00002000;
    private static final int MAX_DUMPSYS_CHARS = 4 * 1024 * 1024;
    private final Object eventLock = new Object();
    private final List<JSONObject> events = new ArrayList<>();
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicLong droppedEvents = new AtomicLong();
    private volatile boolean running = true;
    private UiAutomation automation;
    private String token;
    private int port;
    private ServerSocket server;

    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        token = args == null ? "" : args.getString("token", "");
        port = Integer.parseInt(args == null ? "9008" : args.getString("port", "9008"));
        if (token.length() < 24 || port < 1024 || port > 65535) {
            Bundle result = new Bundle();
            result.putString("error", "Pass -e token with at least 24 characters and a valid unprivileged port");
            finish(1, result);
            return;
        }
        start();
    }

    @Override public void onStart() {
        automation = getUiAutomation();
        AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
        automation.setServiceInfo(info);
        automation.setOnAccessibilityEventListener(event -> {
            try {
                JSONObject item = new JSONObject();
                item.put("sequence", sequence.incrementAndGet());
                item.put("type", AccessibilityEvent.eventTypeToString(event.getEventType()));
                item.put("packageName", text(event.getPackageName()));
                item.put("className", text(event.getClassName()));
                item.put("text", event.getText().toString());
                item.put("timestamp", event.getEventTime());
                synchronized (eventLock) {
                    events.add(item);
                    if (events.size() > 512) {
                        events.remove(0);
                        droppedEvents.incrementAndGet();
                    }
                    eventLock.notifyAll();
                }
            } catch (Exception ignored) { }
        });
        ExecutorService workers = new ThreadPoolExecutor(2, 4, 30L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<Runnable>(16), new ThreadPoolExecutor.AbortPolicy());
        try {
            server = new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
            while (running) {
                Socket socket = server.accept();
                try { workers.execute(() -> handle(socket)); }
                catch (java.util.concurrent.RejectedExecutionException busy) { socket.close(); }
            }
        } catch (Exception error) {
            if (running) {
                Bundle result = new Bundle(); result.putString("error", error.toString()); finish(1, result);
            }
        } finally {
            running = false;
            workers.shutdownNow();
            automation.setOnAccessibilityEventListener(null);
        }
    }

    private static String text(CharSequence value) { return value == null ? "" : value.toString(); }

    private static String line(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int b; (b = in.read()) != -1;) {
            if (b == '\n') return new String(out.toByteArray(), StandardCharsets.UTF_8).replace("\r", "");
            if (out.size() >= 8192) throw new IllegalArgumentException("HTTP header too long");
            out.write(b);
        }
        return out.size() == 0 ? null : new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private void handle(Socket socket) {
        try (Socket owned = socket) {
            InputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = socket.getOutputStream();
            for (int served = 0; running && served < KEEP_ALIVE_MAX_REQUESTS; served++) {
                socket.setSoTimeout(served == 0 ? 35000 : KEEP_ALIVE_IDLE_MS);
                String first = line(in);
                if (first == null) return;
                socket.setSoTimeout(35000);
                String[] parts = first.split(" ", 3);
                if (parts.length != 3) throw new IllegalArgumentException("Malformed request");
                Map<String, String> headers = new HashMap<>();
                for (int i = 0; i < 64; i++) {
                    String header = line(in);
                    if (header == null || header.length() == 0) break;
                    int colon = header.indexOf(':');
                    if (colon <= 0) throw new IllegalArgumentException("Malformed header");
                    headers.put(header.substring(0, colon).toLowerCase(java.util.Locale.ROOT), header.substring(colon + 1).trim());
                    if (i == 63) throw new IllegalArgumentException("Too many headers");
                }
                String connection = headers.containsKey("connection") ? headers.get("connection").toLowerCase(java.util.Locale.ROOT) : "";
                boolean keepAlive = parts[2].trim().equals("HTTP/1.1") && !connection.contains("close")
                        && served + 1 < KEEP_ALIVE_MAX_REQUESTS;
                String provided = headers.get("x-andrui-token");
                if (provided == null || !MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), provided.getBytes(StandardCharsets.UTF_8))) {
                    respond(out, 403, new JSONObject().put("error", "Unauthorized"), false); return;
                }
                int length = Integer.parseInt(headers.containsKey("content-length") ? headers.get("content-length") : "0");
                if (length < 0 || length > MAX_BODY) throw new IllegalArgumentException("Invalid request size");
                byte[] bytes = new byte[length];
                for (int n = 0; n < length;) { int got = in.read(bytes, n, length - n); if (got < 0) throw new IllegalArgumentException("Truncated body"); n += got; }
                JSONObject body = length == 0 ? new JSONObject() : new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                int status;
                JSONObject result;
                try {
                    result = route(parts[0], parts[1], body);
                    status = 200;
                } catch (HelperError error) {
                    status = error.status;
                    result = error.details.put("error", error.code).put("message", error.getMessage());
                } catch (java.util.concurrent.TimeoutException error) {
                    status = 408;
                    result = new JSONObject().put("error", "element_timeout").put("message", error.getMessage());
                } catch (Exception error) {
                    status = 400;
                    result = new JSONObject().put("error", "operation_failed").put("message", error.toString());
                }
                keepAlive = keepAlive && running;
                respond(out, status, result, keepAlive);
                if (!keepAlive) return;
            }
        } catch (Exception ignored) { }
    }

    /** Request failure with a typed error code and optional extra response fields. */
    private static final class HelperError extends Exception {
        final int status;
        final String code;
        final JSONObject details;
        HelperError(int status, String code, String message, JSONObject details) {
            super(message);
            this.status = status;
            this.code = code;
            this.details = details == null ? new JSONObject() : details;
        }
    }

    private JSONObject route(String method, String path, JSONObject body) throws Exception {
        String base = path.split("\\?", 2)[0];
        if (method.equals("GET") && base.equals("/health")) {
            return new JSONObject().put("version", "0.3.0").put("protocolVersion", 1).put("sdk", android.os.Build.VERSION.SDK_INT)
                    .put("capabilities", new JSONArray(new String[]{
                        "hierarchy", "selectors", "xpath", "actions", "wait", "assert",
                        "screenshot", "accessibility-events", "gestures", "key-events",
                        "clear-text", "rich-selectors", "window-metadata", "secure-window-detection", "keep-alive"
                    }));
        }
        if (method.equals("GET") && base.equals("/hierarchy")) {
            Snapshot snap = snapshot();
            return new JSONObject().put("xml", snap.xml()).put("capturedAt", System.currentTimeMillis());
        }
        if (method.equals("GET") && base.equals("/events")) {
            long since = 0;
            String[] query = path.split("\\?", 2);
            if (query.length > 1) for (String pair : query[1].split("&")) {
                String[] kv = pair.split("=", 2);
                if (kv.length == 2 && kv[0].equals("since")) since = Long.parseLong(URLDecoder.decode(kv[1], "UTF-8"));
            }
            JSONArray result = new JSONArray();
            synchronized (eventLock) {
                if (sequence.get() <= since) eventLock.wait(1000);
                for (JSONObject event : events) if (event.getLong("sequence") > since) result.put(event);
            }
            return new JSONObject().put("events", result).put("sequence", sequence.get()).put("dropped", droppedEvents.get());
        }
        if (method.equals("GET") && base.equals("/screenshot")) {
            JSONObject secure = secureWindows();
            Bitmap image = automation.takeScreenshot();
            if (image == null) {
                boolean blocked = secure.getBoolean("visibleSecureWindow");
                throw new HelperError(400, blocked ? "secure_window_blocked" : "screenshot_unavailable",
                        blocked ? "Screenshot unavailable while a FLAG_SECURE window is visible" : "Screenshot unavailable",
                        new JSONObject().put("secure", secure));
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            image.compress(Bitmap.CompressFormat.PNG, 100, out); image.recycle();
            return new JSONObject().put("contentType", "image/png").put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                    .put("secure", secure);
        }
        if (method.equals("POST") && base.equals("/actions")) return action(body);
        if (method.equals("POST") && base.equals("/stop")) {
            running = false;
            server.close();
            return new JSONObject().put("stopped", true);
        }
        throw new IllegalArgumentException("Unknown method/path");
    }

    private JSONObject action(JSONObject body) throws Exception {
        String action = body.getString("action");
        List<String> supported = java.util.Arrays.asList(
            "click", "longClick", "setText", "clearText", "scroll", "swipe", "pressKey", "wait", "assert"
        );
        if (!supported.contains(action)) {
            throw new IllegalArgumentException("Unsupported action: " + action);
        }

        // Global key event injection
        if (action.equals("pressKey")) {
            int keyCode = 0;
            if (body.has("keyCode")) {
                keyCode = body.getInt("keyCode");
            } else if (body.has("key")) {
                String keyName = body.getString("key").toUpperCase(java.util.Locale.ROOT);
                switch (keyName) {
                    case "BACK": keyCode = KeyEvent.KEYCODE_BACK; break;
                    case "HOME": keyCode = KeyEvent.KEYCODE_HOME; break;
                    case "ENTER": keyCode = KeyEvent.KEYCODE_ENTER; break;
                    case "TAB": keyCode = KeyEvent.KEYCODE_TAB; break;
                    case "VOLUME_UP": keyCode = KeyEvent.KEYCODE_VOLUME_UP; break;
                    case "VOLUME_DOWN": keyCode = KeyEvent.KEYCODE_VOLUME_DOWN; break;
                    case "POWER": keyCode = KeyEvent.KEYCODE_POWER; break;
                    case "MENU": keyCode = KeyEvent.KEYCODE_MENU; break;
                    case "DEL":
                    case "BACKSPACE": keyCode = KeyEvent.KEYCODE_DEL; break;
                    default: throw new IllegalArgumentException("Unknown key name: " + keyName);
                }
            } else {
                throw new IllegalArgumentException("pressKey requires 'key' or 'keyCode'");
            }
            long now = SystemClock.uptimeMillis();
            KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0);
            KeyEvent up = new KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0);
            boolean ok1 = automation.injectInputEvent(down, true);
            boolean ok2 = automation.injectInputEvent(up, true);
            if (!ok1 || !ok2) throw new IllegalStateException("Failed to inject key event " + keyCode);
            return new JSONObject().put("success", true).put("action", "pressKey").put("keyCode", keyCode);
        }

        // Coordinate-based swipe injection
        if (action.equals("swipe") && body.has("startX") && body.has("startY") && body.has("endX") && body.has("endY")) {
            float startX = (float) body.getDouble("startX");
            float startY = (float) body.getDouble("startY");
            float endX = (float) body.getDouble("endX");
            float endY = (float) body.getDouble("endY");
            long duration = Math.max(50, Math.min(body.optLong("durationMs", 300), 5000));
            injectSwipe(startX, startY, endX, endY, duration);
            return new JSONObject().put("success", true).put("action", "swipe");
        }

        JSONObject selector = body.optJSONObject("selector");
        if (selector == null || selector.length() == 0) {
            throw new IllegalArgumentException("A non-empty selector is required for action: " + action);
        }

        long timeout = Math.max(0, Math.min(body.optLong("timeoutMs", 10000), 30000));
        long deadline = SystemClock.uptimeMillis() + timeout;
        do {
            Snapshot snap = snapshot();
            AccessibilityNodeInfo target = snap.find(selector);
            boolean expectAbsent = body.optString("condition", "exists").equals("absent");
            if (action.equals("wait") || action.equals("assert")) {
                boolean matched = expectAbsent ? target == null : target != null;
                if (matched) return new JSONObject().put("success", true).put("matched", target != null).put("action", action);
            } else if (target != null) {
                if (action.equals("swipe")) {
                    Rect bounds = new Rect();
                    target.getBoundsInScreen(bounds);
                    String dir = body.optString("direction", "up").toLowerCase(java.util.Locale.ROOT);
                    float startX = bounds.centerX();
                    float startY = bounds.centerY();
                    float endX = startX;
                    float endY = startY;
                    int offset = Math.min(bounds.width(), bounds.height()) / 3;
                    if (offset < 10) offset = 50;
                    if (dir.equals("up")) { startY = bounds.bottom - 20; endY = bounds.top + 20; }
                    else if (dir.equals("down")) { startY = bounds.top + 20; endY = bounds.bottom - 20; }
                    else if (dir.equals("left")) { startX = bounds.right - 20; endX = bounds.left + 20; }
                    else if (dir.equals("right")) { startX = bounds.left + 20; endX = bounds.right - 20; }
                    long duration = Math.max(50, Math.min(body.optLong("durationMs", 300), 5000));
                    injectSwipe(startX, startY, endX, endY, duration);
                    return new JSONObject().put("success", true).put("action", "swipe").put("target", describe(target));
                }

                int code;
                Bundle args = new Bundle();
                switch (action) {
                    case "click": code = AccessibilityNodeInfo.ACTION_CLICK; break;
                    case "longClick": code = AccessibilityNodeInfo.ACTION_LONG_CLICK; break;
                    case "setText":
                        code = AccessibilityNodeInfo.ACTION_SET_TEXT;
                        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, body.getString("text"));
                        break;
                    case "clearText":
                        code = AccessibilityNodeInfo.ACTION_SET_TEXT;
                        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "");
                        break;
                    case "scroll":
                        code = body.optString("direction", "forward").equals("backward")
                                ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
                        break;
                    default: throw new IllegalArgumentException("Unsupported action: " + action);
                }
                if (!target.refresh()) {
                    if (SystemClock.uptimeMillis() >= deadline) break;
                    SystemClock.sleep(50);
                    continue;
                }
                if (!target.performAction(code, args)) {
                    StringBuilder sb = new StringBuilder();
                    sb.append("Node rejected action '").append(action).append("'");
                    sb.append("; enabled=").append(target.isEnabled());
                    sb.append(", clickable=").append(target.isClickable());
                    sb.append(", visible=").append(target.isVisibleToUser());
                    List<AccessibilityNodeInfo.AccessibilityAction> acts = target.getActionList();
                    sb.append(", supportedActions=[");
                    if (acts != null) {
                        for (int i = 0; i < acts.size(); i++) {
                            if (i > 0) sb.append(", ");
                            sb.append(acts.get(i).getId());
                        }
                    }
                    sb.append("]");
                    throw new IllegalStateException(sb.toString());
                }
                return new JSONObject().put("success", true).put("action", action).put("target", describe(target));
            }
            if (SystemClock.uptimeMillis() >= deadline) break;
            SystemClock.sleep(Math.min(100, deadline - SystemClock.uptimeMillis()));
        } while (running);
        throw new java.util.concurrent.TimeoutException("Selector did not satisfy " + action + " within " + timeout + " ms");
    }

    private void injectSwipe(float startX, float startY, float endX, float endY, long duration) {
        long downTime = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, startX, startY, 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        automation.injectInputEvent(down, true);
        down.recycle();

        long startTime = SystemClock.uptimeMillis();
        long endTime = startTime + duration;
        long now = startTime;
        while (now < endTime) {
            float progress = (float) (now - startTime) / (float) duration;
            float curX = startX + (endX - startX) * progress;
            float curY = startY + (endY - startY) * progress;
            MotionEvent move = MotionEvent.obtain(downTime, now, MotionEvent.ACTION_MOVE, curX, curY, 0);
            move.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            automation.injectInputEvent(move, true);
            move.recycle();
            SystemClock.sleep(16);
            now = SystemClock.uptimeMillis();
        }

        MotionEvent up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, endX, endY, 0);
        up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        automation.injectInputEvent(up, true);
        up.recycle();
    }

    private static JSONObject describe(AccessibilityNodeInfo node) throws Exception {
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        return new JSONObject().put("resourceId", text(node.getViewIdResourceName())).put("text", text(node.getText()))
                .put("description", text(node.getContentDescription())).put("bounds", bounds.flattenToString());
    }

    /**
     * Reports FLAG_SECURE windows from a fixed internal `dumpsys window windows` query.
     * Android normally blanks secure layers in screenshots instead of failing, so callers
     * use this to tell a hidden secure surface from a genuinely dark screen.
     */
    private JSONObject secureWindows() {
        JSONObject report = new JSONObject();
        JSONArray windows = new JSONArray();
        boolean anyVisible = false;
        try {
            ParcelFileDescriptor pfd = automation.executeShellCommand("dumpsys window windows");
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new ParcelFileDescriptor.AutoCloseInputStream(pfd), StandardCharsets.UTF_8))) {
                String title = null;
                boolean secure = false, visible = false;
                int chars = 0;
                for (String raw; (raw = reader.readLine()) != null && chars < MAX_DUMPSYS_CHARS;) {
                    chars += raw.length() + 1;
                    String row = raw.trim();
                    if (row.startsWith("Window #") && row.contains("Window{")) {
                        if (title != null && secure) { windows.put(secureEntry(title, visible)); anyVisible |= visible; }
                        int open = row.indexOf("Window{"), close = row.lastIndexOf('}');
                        String inner = close > open ? row.substring(open + 7, close) : "";
                        String[] fields = inner.split(" ", 3);
                        title = fields.length == 3 ? fields[2] : inner;
                        secure = false; visible = false;
                        continue;
                    }
                    if (title == null) continue;
                    if (hasSecureFlag(row)) secure = true;
                    if (row.contains("isVisible=true") || row.contains("isOnScreen=true")) visible = true;
                }
                if (title != null && secure) { windows.put(secureEntry(title, visible)); anyVisible |= visible; }
            }
            report.put("detection", "dumpsys");
        } catch (Exception error) {
            try { report.put("detection", "unavailable").put("message", error.toString()); } catch (Exception ignored) { }
        }
        try { report.put("windows", windows).put("visibleSecureWindow", anyVisible); } catch (Exception ignored) { }
        return report;
    }

    private static JSONObject secureEntry(String title, boolean visible) throws Exception {
        return new JSONObject().put("title", title).put("visible", visible);
    }

    /** Matches the `fl=` window flags field, printed by name (SECURE) or as hex (#...). */
    private static boolean hasSecureFlag(String row) {
        int at = -1;
        for (int i = row.indexOf("fl="); i >= 0; i = row.indexOf("fl=", i + 3)) {
            if (i == 0 || row.charAt(i - 1) == ' ' || row.charAt(i - 1) == '{') { at = i; break; }
        }
        if (at < 0) return false;
        String[] tokens = row.substring(at + 3).split(" ");
        if (tokens.length > 0 && tokens[0].startsWith("#")) {
            try { return (Long.parseLong(tokens[0].substring(1), 16) & FLAG_SECURE) != 0; }
            catch (NumberFormatException ignored) { return false; }
        }
        for (String token : tokens) {
            if (token.contains("=")) break;
            if (token.replace("}", "").equals("SECURE")) return true;
        }
        return false;
    }

    private Snapshot snapshot() throws Exception {
        Snapshot result = new Snapshot();
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            SparseArray<List<AccessibilityWindowInfo>> displays = automation.getWindowsOnAllDisplays();
            for (int i = 0; i < displays.size(); i++) addWindows(result, displays.valueAt(i), displays.keyAt(i));
        } else {
            // Before API 30, UiAutomation exposes only the default display (id 0).
            addWindows(result, automation.getWindows(), 0);
        }
        if (result.nodes.isEmpty()) {
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root != null) result.add(root, result.root, 0);
        }
        return result;
    }

    /** Adds each window's tree, tagging its root node with window and display metadata. */
    private static void addWindows(Snapshot snapshot, List<AccessibilityWindowInfo> windows, int displayId) {
        for (AccessibilityWindowInfo window : windows) {
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            Element item = snapshot.add(root, snapshot.root, 0);
            if (item == null) continue;
            item.setAttribute("display-id", Integer.toString(displayId));
            item.setAttribute("window-id", Integer.toString(window.getId()));
            item.setAttribute("window-type", windowType(window.getType()));
            item.setAttribute("window-layer", Integer.toString(window.getLayer()));
            item.setAttribute("window-active", Boolean.toString(window.isActive()));
            item.setAttribute("window-focused", Boolean.toString(window.isFocused()));
            if (android.os.Build.VERSION.SDK_INT >= 24) item.setAttribute("window-title", text(window.getTitle()));
        }
    }

    private static String windowType(int type) {
        switch (type) {
            case AccessibilityWindowInfo.TYPE_APPLICATION: return "application";
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return "input-method";
            case AccessibilityWindowInfo.TYPE_SYSTEM: return "system";
            case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY: return "accessibility-overlay";
            case AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER: return "split-screen-divider";
            case AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY: return "magnification-overlay";
            case -1: return "undefined"; // AOSP's unset type, e.g. always-on-display windows
            default: return "unknown-" + type;
        }
    }

    private static final class Snapshot {
        final Document document;
        final Element root;
        final List<AccessibilityNodeInfo> nodes = new ArrayList<>();
        Snapshot() throws Exception {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            document = factory.newDocumentBuilder().newDocument();
            root = document.createElement("hierarchy"); document.appendChild(root);
        }
        Element add(AccessibilityNodeInfo node, Element parent, int depth) {
            if (depth > 80 || nodes.size() >= 10000) return null;
            Element item = document.createElement("node");
            item.setAttribute("node-index", Integer.toString(nodes.size())); nodes.add(node);
            item.setAttribute("resource-id", text(node.getViewIdResourceName()));
            item.setAttribute("text", text(node.getText()));
            item.setAttribute("content-desc", text(node.getContentDescription()));
            item.setAttribute("class", text(node.getClassName()));
            item.setAttribute("package", text(node.getPackageName()));
            item.setAttribute("clickable", Boolean.toString(node.isClickable()));
            item.setAttribute("enabled", Boolean.toString(node.isEnabled()));
            item.setAttribute("scrollable", Boolean.toString(node.isScrollable()));
            item.setAttribute("checked", Boolean.toString(node.isChecked()));
            item.setAttribute("focused", Boolean.toString(node.isFocused()));
            item.setAttribute("selected", Boolean.toString(node.isSelected()));
            item.setAttribute("checkable", Boolean.toString(node.isCheckable()));
            item.setAttribute("password", Boolean.toString(node.isPassword()));
            item.setAttribute("visible-to-user", Boolean.toString(node.isVisibleToUser()));
            CharSequence err = node.getError();
            if (err != null) item.setAttribute("error-text", err.toString());
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                CharSequence hint = node.getHintText();
                if (hint != null) item.setAttribute("hint-text", hint.toString());
            }
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                CharSequence pane = node.getPaneTitle();
                if (pane != null) item.setAttribute("pane-title", pane.toString());
            }
            List<AccessibilityNodeInfo.AccessibilityAction> actionList = node.getActionList();
            if (actionList != null && !actionList.isEmpty()) {
                StringBuilder actionsStr = new StringBuilder();
                for (int i = 0; i < actionList.size(); i++) {
                    if (i > 0) actionsStr.append(",");
                    actionsStr.append(actionList.get(i).getId());
                }
                item.setAttribute("actions", actionsStr.toString());
            }
            Rect b = new Rect(); node.getBoundsInScreen(b);
            item.setAttribute("bounds", "["+b.left+","+b.top+"]["+b.right+","+b.bottom+"]");
            parent.appendChild(item);
            for (int i = 0; i < node.getChildCount(); i++) { AccessibilityNodeInfo child = node.getChild(i); if (child != null) add(child, item, depth + 1); }
            return item;
        }
        String xml() throws Exception {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            javax.xml.transform.Transformer transformer = TransformerFactory.newInstance().newTransformer();
            transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
            transformer.transform(new DOMSource(document), new StreamResult(out));
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
        AccessibilityNodeInfo find(JSONObject selector) throws Exception {
            if (selector.has("xpath")) {
                Element selected = (Element) XPathFactory.newInstance().newXPath().evaluate(selector.getString("xpath"), document, XPathConstants.NODE);
                if (selected == null || !selected.hasAttribute("node-index")) return null;
                return nodes.get(Integer.parseInt(selected.getAttribute("node-index")));
            }
            String[][] exactAttrs = {
                {"resourceId", "resource-id"},
                {"text", "text"},
                {"description", "content-desc"},
                {"className", "class"}
            };
            for (String key : new String[]{"resourceId", "text", "description", "className"}) {
                if (selector.has(key) && selector.getString(key).isEmpty()) {
                    throw new IllegalArgumentException("Selector values must not be empty");
                }
            }
            for (String key : new String[]{"textContains", "textStartsWith", "textMatches", "descContains", "descMatches", "resourceIdMatches"}) {
                if (selector.has(key) && selector.getString(key).isEmpty()) {
                    throw new IllegalArgumentException("Selector values must not be empty");
                }
            }

            int targetIndex = selector.optInt("index", 0);
            int matchCount = 0;

            NodeList items = document.getElementsByTagName("node");
            for (int i = 0; i < items.getLength(); i++) {
                Element item = (Element) items.item(i);
                boolean match = true;
                int conditions = 0;

                // Exact attribute matches
                for (String[] pair : exactAttrs) {
                    if (selector.has(pair[0])) {
                        conditions++;
                        if (!item.getAttribute(pair[1]).equals(selector.getString(pair[0]))) {
                            match = false;
                            break;
                        }
                    }
                }
                if (!match) continue;

                // Substring & prefix matches
                if (selector.has("textContains")) {
                    conditions++;
                    if (!item.getAttribute("text").contains(selector.getString("textContains"))) match = false;
                }
                if (match && selector.has("textStartsWith")) {
                    conditions++;
                    if (!item.getAttribute("text").startsWith(selector.getString("textStartsWith"))) match = false;
                }
                if (match && selector.has("descContains")) {
                    conditions++;
                    if (!item.getAttribute("content-desc").contains(selector.getString("descContains"))) match = false;
                }

                // Regex matches
                if (match && selector.has("textMatches")) {
                    conditions++;
                    if (!item.getAttribute("text").matches(selector.getString("textMatches"))) match = false;
                }
                if (match && selector.has("descMatches")) {
                    conditions++;
                    if (!item.getAttribute("content-desc").matches(selector.getString("descMatches"))) match = false;
                }
                if (match && selector.has("resourceIdMatches")) {
                    conditions++;
                    if (!item.getAttribute("resource-id").matches(selector.getString("resourceIdMatches"))) match = false;
                }

                // State flags
                if (match && selector.has("checked")) {
                    conditions++;
                    if (!item.getAttribute("checked").equals(Boolean.toString(selector.getBoolean("checked")))) match = false;
                }
                if (match && selector.has("enabled")) {
                    conditions++;
                    if (!item.getAttribute("enabled").equals(Boolean.toString(selector.getBoolean("enabled")))) match = false;
                }
                if (match && selector.has("selected")) {
                    conditions++;
                    if (!item.getAttribute("selected").equals(Boolean.toString(selector.getBoolean("selected")))) match = false;
                }
                if (match && selector.has("focused")) {
                    conditions++;
                    if (!item.getAttribute("focused").equals(Boolean.toString(selector.getBoolean("focused")))) match = false;
                }

                if (match && conditions > 0) {
                    if (matchCount == targetIndex) {
                        return nodes.get(Integer.parseInt(item.getAttribute("node-index")));
                    }
                    matchCount++;
                }
            }
            return null;
        }
    }

    private static void respond(OutputStream out, int status, JSONObject body, boolean keepAlive) throws Exception {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        String reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : status == 408 ? "Request Timeout" : "Bad Request";
        String connection = keepAlive ? "keep-alive\r\nKeep-Alive: timeout=" + (KEEP_ALIVE_IDLE_MS / 1000) : "close";
        byte[] head = ("HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " + bytes.length + "\r\nConnection: " + connection + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
        // One write per response: split writes stall on reused sockets (Nagle + delayed ACK).
        byte[] packet = new byte[head.length + bytes.length];
        System.arraycopy(head, 0, packet, 0, head.length);
        System.arraycopy(bytes, 0, packet, head.length, bytes.length);
        out.write(packet); out.flush();
    }
}
