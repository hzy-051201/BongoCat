use rdev::{Event, EventType, listen};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, command};

#[derive(Debug, Clone, Serialize)]
pub enum DeviceEventKind {
    MousePress,
    MouseRelease,
    MouseMove,
    MouseDelta,
    KeyboardPress,
    KeyboardRelease,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceEvent {
    kind: DeviceEventKind,
    value: Value,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct MouseDelta {
    x: i32,
    y: i32,
}

#[cfg(target_os = "windows")]
fn relative_mouse_delta(last_x: i32, last_y: i32) -> MouseDelta {
    MouseDelta {
        x: last_x,
        y: last_y,
    }
}

static IS_LISTENING: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
static IS_RAW_LISTENING: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
static FIRST_DELTA_LOGGED: AtomicBool = AtomicBool::new(false);

#[command]
pub async fn start_device_listening(app_handle: AppHandle) -> Result<(), String> {
    if IS_LISTENING.load(Ordering::SeqCst) {
        return Ok(());
    }

    IS_LISTENING.store(true, Ordering::SeqCst);

    #[cfg(target_os = "windows")]
    start_raw_input_listener(app_handle.clone());

    let callback = move |event: Event| {
        let device_event = match event.event_type {
            EventType::ButtonPress(button) => DeviceEvent {
                kind: DeviceEventKind::MousePress,
                value: json!(format!("{:?}", button)),
            },
            EventType::ButtonRelease(button) => DeviceEvent {
                kind: DeviceEventKind::MouseRelease,
                value: json!(format!("{:?}", button)),
            },
            EventType::MouseMove { x, y } => DeviceEvent {
                kind: DeviceEventKind::MouseMove,
                value: json!({ "x": x, "y": y }),
            },
            EventType::KeyPress(key) => DeviceEvent {
                kind: DeviceEventKind::KeyboardPress,
                value: json!(format!("{:?}", key)),
            },
            EventType::KeyRelease(key) => DeviceEvent {
                kind: DeviceEventKind::KeyboardRelease,
                value: json!(format!("{:?}", key)),
            },
            _ => return,
        };

        let _ = app_handle.emit("device-changed", device_event);
    };

    listen(callback).map_err(|err| format!("Failed to listen device: {:?}", err))?;

    Ok(())
}

#[cfg(target_os = "windows")]
static RAW_INPUT_HANDLE: std::sync::Mutex<Option<AppHandle<tauri::Wry>>> =
    std::sync::Mutex::new(None);

#[cfg(target_os = "windows")]
fn start_raw_input_listener(app_handle: AppHandle) {
    if IS_RAW_LISTENING.swap(true, Ordering::SeqCst) {
        return;
    }

    *RAW_INPUT_HANDLE.lock().unwrap() = Some(app_handle);

    let spawned = std::thread::Builder::new()
        .name("bongo-cat-raw-input".to_string())
        .spawn(raw_input_message_loop);

    if spawned.is_err() {
        log::error!("raw input: failed to spawn message loop thread");
    }
}

#[cfg(target_os = "windows")]
fn raw_input_message_loop() {
    use std::mem::size_of;

    use windows::Win32::Devices::HumanInterfaceDevice::{
        HID_USAGE_GENERIC_MOUSE, HID_USAGE_PAGE_GENERIC,
    };
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::{
        GetRawInputData, HRAWINPUT, MOUSE_MOVE_ABSOLUTE, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER,
        RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEMOUSE, RegisterRawInputDevices,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HWND_MESSAGE,
        MSG, RegisterClassW, TranslateMessage, UnregisterClassW, WINDOW_EX_STYLE, WINDOW_STYLE,
        WNDCLASSW, WM_INPUT,
    };
    use windows::core::PCWSTR;

    const CLASS_NAME: &str = "BongoCatRawInput";

    unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_INPUT {
            if let Some(delta) = read_raw_mouse_delta(lparam) {
                if !FIRST_DELTA_LOGGED.swap(true, Ordering::SeqCst) {
                    log::info!("raw input: received first mouse delta");
                }

                if let Some(app_handle) = RAW_INPUT_HANDLE.lock().unwrap().as_ref() {
                    let _ = app_handle.emit(
                        "device-changed",
                        DeviceEvent {
                            kind: DeviceEventKind::MouseDelta,
                            value: json!(delta),
                        },
                    );
                }
            }

            return LRESULT::default();
        }

        let _ = wparam;

        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    fn read_raw_mouse_delta(lparam: LPARAM) -> Option<MouseDelta> {
        unsafe {
            let raw_input = HRAWINPUT(lparam.0 as *mut _);

            let mut buffer_size = 0u32;

            GetRawInputData(
                raw_input,
                RID_INPUT,
                None,
                &mut buffer_size,
                size_of::<RAWINPUTHEADER>() as u32,
            );

            if buffer_size == 0 {
                return None;
            }

            let mut buffer = vec![0u8; buffer_size as usize];

            let read = GetRawInputData(
                raw_input,
                RID_INPUT,
                Some(buffer.as_mut_ptr().cast()),
                &mut buffer_size,
                size_of::<RAWINPUTHEADER>() as u32,
            );

            if read == 0 {
                return None;
            }

            let raw = &*buffer.as_ptr().cast::<RAWINPUT>();

            if raw.header.dwType != RIM_TYPEMOUSE.0 {
                return None;
            }

            if (raw.data.mouse.usFlags.0 & MOUSE_MOVE_ABSOLUTE.0) != 0 {
                return None;
            }

            Some(relative_mouse_delta(raw.data.mouse.lLastX, raw.data.mouse.lLastY))
        }
    }

    unsafe {
        let class_name: Vec<u16> = CLASS_NAME.encode_utf16().chain(core::iter::once(0)).collect();
        let class_name_ptr = PCWSTR(class_name.as_ptr());

        let Ok(hmodule) = GetModuleHandleW(None) else {
            log::error!("raw input: GetModuleHandleW failed");

            return;
        };

        let hinstance = HINSTANCE(hmodule.0);

        let window_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            lpszClassName: class_name_ptr,
            hInstance: hinstance,
            ..Default::default()
        };

        if RegisterClassW(&window_class) == 0 {
            log::error!("raw input: RegisterClassW failed");

            return;
        }

        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name_ptr,
            PCWSTR::null(),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance),
            None,
        ) else {
            log::error!("raw input: CreateWindowExW failed");

            return;
        };

        let raw_input_device = RAWINPUTDEVICE {
            usUsagePage: HID_USAGE_PAGE_GENERIC,
            usUsage: HID_USAGE_GENERIC_MOUSE,
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        };

        if RegisterRawInputDevices(&[raw_input_device], size_of::<RAWINPUTDEVICE>() as u32).is_err() {
            log::error!("raw input: RegisterRawInputDevices failed");

            let _ = DestroyWindow(hwnd);

            return;
        }

        log::info!("raw input: registered RIDEV_INPUTSINK for mouse");

        let mut message = MSG::default();

        loop {
            let result = GetMessageW(&mut message, None, 0, 0);

            if result.0 <= 0 {
                break;
            }

            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(class_name_ptr, Some(hinstance));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn relative_mouse_delta_uses_signed_raw_values() {
        assert_eq!(relative_mouse_delta(12, -8), MouseDelta { x: 12, y: -8 });
    }
}
