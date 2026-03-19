import torch
import numpy as np
import os
import hashlib
import base64
import io
from PIL import Image, ImageOps
import folder_paths


class SketchPad:
    """
    Combined image loader + interactive drawing canvas.
    Load an image (from file or upstream IMAGE input), draw colored
    annotations (R/G/B), and output the original image and annotated image.
    """

    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = sorted(
            [f for f in os.listdir(input_dir)
             if os.path.isfile(os.path.join(input_dir, f))]
        )
        return {
            "required": {
                "image": (files, {"image_upload": True}),
            },
            "optional": {
                "input_image": ("IMAGE",),
            },
            "hidden": {
                "canvas_data": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("original_image", "annotated_image")
    FUNCTION = "execute"
    CATEGORY = "image/sketch"

    def execute(self, image, input_image=None, canvas_data=""):
        if input_image is not None:
            # Use connected upstream IMAGE tensor: [B, H, W, C]
            original_tensor = input_image
            original_np = input_image[0].cpu().numpy()
            h, w = original_np.shape[:2]
        else:
            # Load from file selector (same pattern as built-in LoadImage)
            image_path = folder_paths.get_annotated_filepath(image)
            img = Image.open(image_path)
            img = ImageOps.exif_transpose(img)

            if img.mode == "I":
                img = img.point(lambda i: i * (1 / 255))

            original_pil = img.convert("RGB")
            original_np = np.array(original_pil).astype(np.float32) / 255.0
            original_tensor = torch.from_numpy(original_np)[None,]

            h, w = original_np.shape[:2]

        if canvas_data and canvas_data.strip():
            # Strip data URL prefix if present
            data = canvas_data
            if data.startswith("data:"):
                data = data.split(",", 1)[1]

            canvas_bytes = base64.b64decode(data)
            canvas_img = Image.open(io.BytesIO(canvas_bytes)).convert("RGBA")

            # Resize canvas to match source image dimensions
            if canvas_img.size != (w, h):
                canvas_img = canvas_img.resize((w, h), Image.LANCZOS)

            canvas_np = np.array(canvas_img).astype(np.float32) / 255.0

            # Composite annotated image: original blended with drawing overlay
            alpha = canvas_np[:, :, 3]
            overlay_rgb = canvas_np[:, :, :3]
            alpha_3ch = alpha[:, :, np.newaxis]
            annotated_np = original_np * (1 - alpha_3ch) + overlay_rgb * alpha_3ch
            annotated_tensor = torch.from_numpy(annotated_np)[None,]
        else:
            annotated_tensor = original_tensor.clone()

        return (original_tensor, annotated_tensor)

    @classmethod
    def IS_CHANGED(s, image, input_image=None, canvas_data=""):
        m = hashlib.sha256()
        if input_image is not None:
            m.update(b"input_image_connected")
        else:
            image_path = folder_paths.get_annotated_filepath(image)
            with open(image_path, "rb") as f:
                m.update(f.read())
        m.update((canvas_data or "").encode("utf-8"))
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, image, input_image=None, canvas_data=""):
        if input_image is None and not folder_paths.exists_annotated_filepath(image):
            return "Invalid image file: {}".format(image)
        return True


NODE_CLASS_MAPPINGS = {
    "SketchPad": SketchPad
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SketchPad": "Sketch Pad"
}
