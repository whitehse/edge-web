/**
 * Shared WebGPU device + per-canvas time-series triangle renderer.
 * Vertex format: interleaved x,y,r,g,b,a in CSS pixel space (+Y down).
 */

const WGSL = /* wgsl */ `
struct Cam {
  width: f32,
  height: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> cam: Cam;

struct VSIn {
  @location(0) pos: vec2f,
  @location(1) color: vec4f,
};

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vs_main(v: VSIn) -> VSOut {
  var o: VSOut;
  let nx = (v.pos.x / cam.width) * 2.0 - 1.0;
  let ny = 1.0 - (v.pos.y / cam.height) * 2.0;
  o.clip = vec4f(nx, ny, 0.0, 1.0);
  o.color = v.color;
  return o;
}

@fragment
fn fs_main(i: VSOut) -> @location(0) vec4f {
  return i.color;
}
`;

let shared = null; /* { device, format, pipeline, bindGroupLayout, module } */

export function webgpuAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

async function getShared() {
  if (shared) return shared;
  if (!navigator.gpu) throw new Error("WebGPU not available");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({ code: WGSL, label: "ts_mesh" });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" }
      }
    ]
  });
  const pipeline = device.createRenderPipeline({
    label: "ts_pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout]
    }),
    vertex: {
      module,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x4" }
          ]
        }
      ]
    },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha"
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha"
            }
          }
        }
      ]
    },
    primitive: { topology: "triangle-list" }
  });
  shared = { device, format, pipeline, bindGroupLayout, module };
  return shared;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<{ draw: Function, destroy: Function, mode: string }>}
 */
export async function createWebGpuTsRenderer(canvas) {
  const s = await getShared();
  const { device, format, pipeline, bindGroupLayout } = s;
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("webgpu context failed");

  const uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }]
  });

  let vertBuf = null;
  let vertCap = 0;
  const camF32 = new Float32Array(4);
  let destroyed = false;

  function configure() {
    context.configure({
      device,
      format,
      alphaMode: "premultiplied"
    });
  }
  configure();

  /**
   * @param {Float32Array} verts
   * @param {{ cssW: number, cssH: number, clear?: number[] }} camera
   */
  function draw(verts, camera) {
    if (destroyed) return;
    const cssW = camera?.cssW > 0 ? camera.cssW : canvas.clientWidth || 1;
    const cssH = camera?.cssH > 0 ? camera.cssH : canvas.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.floor(cssW * dpr));
    const bh = Math.max(1, Math.floor(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      configure();
    }
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";

    /* Mesh is in CSS px; shader uses cam as CSS size → NDC */
    camF32[0] = cssW;
    camF32[1] = cssH;
    camF32[2] = 0;
    camF32[3] = 0;
    device.queue.writeBuffer(uniformBuf, 0, camF32);

    const nFloats = verts?.length ?? 0;
    const nVerts = Math.floor(nFloats / 6);
    const bytes = nVerts * 24;
    if (nVerts > 0) {
      if (!vertBuf || bytes > vertCap) {
        if (vertBuf) vertBuf.destroy();
        vertCap = Math.max(bytes, 24 * 256);
        vertBuf = device.createBuffer({
          size: vertCap,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
      }
      device.queue.writeBuffer(vertBuf, 0, verts);
    }

    const clear = camera?.clear || [0.09, 0.11, 0.16, 1];
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: {
            r: clear[0],
            g: clear[1],
            b: clear[2],
            a: clear[3]
          },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    if (nVerts > 0 && vertBuf) {
      pass.setVertexBuffer(0, vertBuf);
      pass.draw(nVerts);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function destroy() {
    destroyed = true;
    if (vertBuf) {
      vertBuf.destroy();
      vertBuf = null;
    }
    try {
      uniformBuf.destroy();
    } catch (e) {
      /* ignore */
    }
  }

  return { draw, destroy, mode: "webgpu", device };
}
