import { ViewerContext } from "./App";
import { CameraControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as holdEvent from "hold-event";
import React, { useContext, useRef } from "react";
import { PerspectiveCamera } from "three";
import * as THREE from "three";
import { computeT_threeworld_world } from "./WorldTransformUtils";
import { useThrottledMessageSender } from "./WebsocketFunctions";

export function SynchronizedCameraControls() {
  const viewer = useContext(ViewerContext)!;
  const camera = useThree((state) => state.camera as PerspectiveCamera);

  const sendCameraThrottled = useThrottledMessageSender(20);

  // Helper for resetting camera poses.
  const initialCameraRef = useRef<{
    camera: PerspectiveCamera;
    lookAt: THREE.Vector3;
  } | null>(null);

  viewer.resetCameraViewRef.current = () => {
    viewer.cameraControlRef.current!.setLookAt(
      initialCameraRef.current!.camera.position.x,
      initialCameraRef.current!.camera.position.y,
      initialCameraRef.current!.camera.position.z,
      initialCameraRef.current!.lookAt.x,
      initialCameraRef.current!.lookAt.y,
      initialCameraRef.current!.lookAt.z,
      true,
    );
    viewer.cameraRef.current!.up.set(
      initialCameraRef.current!.camera.up.x,
      initialCameraRef.current!.camera.up.y,
      initialCameraRef.current!.camera.up.z,
    );
    viewer.cameraControlRef.current!.updateCameraUp();
  };

  // Callback for sending cameras.
  // It makes the code more chaotic, but we preallocate a bunch of things to
  // minimize garbage collection!
  const R_threecam_cam = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(Math.PI, 0.0, 0.0),
  );
  const R_world_threeworld = new THREE.Quaternion();
  const tmpMatrix4 = new THREE.Matrix4();
  const lookAt = new THREE.Vector3();
  const R_world_camera = new THREE.Quaternion();
  const t_world_camera = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const sendCamera = React.useCallback(() => {
    const three_camera = camera;
    const camera_control = viewer.cameraControlRef.current;

    if (camera_control === null) {
      // Camera controls not yet ready, let's re-try later.
      setTimeout(sendCamera, 10);
      return;
    }

    // We put Z up to match the scene tree, and convert threejs camera convention
    // to the OpenCV one.
    const T_world_threeworld = computeT_threeworld_world(viewer).invert();
    const T_world_camera = T_world_threeworld.clone()
      .multiply(
        tmpMatrix4
          .makeRotationFromQuaternion(three_camera.quaternion)
          .setPosition(three_camera.position),
      )
      .multiply(tmpMatrix4.makeRotationFromQuaternion(R_threecam_cam));
    R_world_threeworld.setFromRotationMatrix(T_world_threeworld);

    camera_control.getTarget(lookAt).applyQuaternion(R_world_threeworld);
    const up = three_camera.up.clone().applyQuaternion(R_world_threeworld);

    //Store initial camera values
    if (initialCameraRef.current === null) {
      initialCameraRef.current = {
        camera: three_camera.clone(),
        lookAt: camera_control.getTarget(new THREE.Vector3()),
      };
    }

    T_world_camera.decompose(t_world_camera, R_world_camera, scale);

    sendCameraThrottled({
      type: "ViewerCameraMessage",
      wxyz: [
        R_world_camera.w,
        R_world_camera.x,
        R_world_camera.y,
        R_world_camera.z,
      ],
      position: t_world_camera.toArray(),
      aspect: three_camera.aspect,
      fov: (three_camera.fov * Math.PI) / 180.0,
      look_at: [lookAt.x, lookAt.y, lookAt.z],
      up_direction: [up.x, up.y, up.z],
    });

    // Log camera.
    if (logCamera != undefined) {
      console.log("Sending camera", t_world_camera.toArray(), lookAt);
    }
  }, [camera, sendCameraThrottled]);

  // Camera control search parameters.
  // EXPERIMENTAL: these may be removed or renamed in the future. Please pin to
  // a commit/version if you're relying on this (undocumented) feature.
  const searchParams = new URLSearchParams(window.location.search);
  const initialCameraPosString = searchParams.get("initialCameraPosition");
  const initialCameraLookAtString = searchParams.get("initialCameraLookAt");
  const logCamera = searchParams.get("logCamera");

  // Send camera for new connections.
  // We add a small delay to give the server time to add a callback.
  const connected = viewer.useGui((state) => state.websocketConnected);
  const initialCameraPositionSet = React.useRef(false);
  React.useEffect(() => {
    if (!initialCameraPositionSet.current) {
      const initialCameraPos = new THREE.Vector3(
        ...((initialCameraPosString
          ? (initialCameraPosString.split(",").map(Number) as [
              number,
              number,
              number,
            ])
          : [3.0, 3.0, 3.0]) as [number, number, number]),
      );
      initialCameraPos.applyMatrix4(computeT_threeworld_world(viewer));
      const initialCameraLookAt = new THREE.Vector3(
        ...((initialCameraLookAtString
          ? (initialCameraLookAtString.split(",").map(Number) as [
              number,
              number,
              number,
            ])
          : [0, 0, 0]) as [number, number, number]),
      );
      initialCameraLookAt.applyMatrix4(computeT_threeworld_world(viewer));

      viewer.cameraControlRef.current!.setLookAt(
        initialCameraPos.x,
        initialCameraPos.y,
        initialCameraPos.z,
        initialCameraLookAt.x,
        initialCameraLookAt.y,
        initialCameraLookAt.z,
        false,
      );
      initialCameraPositionSet.current = true;
    }

    viewer.sendCameraRef.current = sendCamera;
    if (!connected) return;
    setTimeout(() => sendCamera(), 50);
  }, [connected, sendCamera]);

  // Send camera for 3D viewport changes.
  const canvas = viewer.canvasRef.current!; // R3F canvas.
  React.useEffect(() => {
    // Create a resize observer to resize the CSS canvas when the window is resized.
    const resizeObserver = new ResizeObserver(() => {
      sendCamera();
    });
    resizeObserver.observe(canvas);

    // Cleanup.
    return () => resizeObserver.disconnect();
  }, [canvas]);

  /**
   * hack: in our scenario, we want to disable camera controls so that dragging the background scene tree nodes doesn't move the camera. This solution is based on the GitHub issue reply in https://github.com/nerfstudio-project/viser/issues/366
   */
  return (
    <CameraControls
      ref={viewer.cameraControlRef}
      minDistance={0.1}
      maxDistance={200.0}
      dollySpeed={0}
      truckSpeed={0}
      polarRotateSpeed={0}
      azimuthRotateSpeed={0}
      smoothTime={0.05}
      draggingSmoothTime={0.0}
      onChange={sendCamera}
      // makeDefault
    />
  );
}
