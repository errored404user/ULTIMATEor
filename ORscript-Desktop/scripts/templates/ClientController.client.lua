--!strict
-- ClientController.client.lua (LocalScript, StarterPlayerScripts)
-- Input handling with ContextActionService, a lightweight HUD and a clean
-- character lifecycle. Pairs with RemoteBus for server communication.

local Players = game:GetService("Players")
local ContextActionService = game:GetService("ContextActionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

local sharedFolder = ReplicatedStorage:FindFirstChild("Shared")
local RemoteBus = sharedFolder and sharedFolder:FindFirstChild("RemoteBus") and require(sharedFolder.RemoteBus) or nil

-- HUD -------------------------------------------------------------------------
local screen = Instance.new("ScreenGui")
screen.Name = "HUD"
screen.ResetOnSpawn = false
screen.IgnoreGuiInset = true
screen.Parent = playerGui

local label = Instance.new("TextLabel")
label.Name = "Status"
label.AnchorPoint = Vector2.new(0.5, 1)
label.Position = UDim2.fromScale(0.5, 0.95)
label.Size = UDim2.fromOffset(320, 36)
label.BackgroundColor3 = Color3.fromRGB(20, 18, 14)
label.BackgroundTransparency = 0.2
label.TextColor3 = Color3.fromRGB(240, 180, 41)
label.Font = Enum.Font.GothamMedium
label.TextSize = 16
label.Text = "Ready"
label.Parent = screen
Instance.new("UICorner", label).CornerRadius = UDim.new(0, 10)

local function flash(text: string)
	label.Text = text
	label.TextTransparency = 0
	TweenService:Create(label, TweenInfo.new(1.2, Enum.EasingStyle.Quad, Enum.EasingDirection.In), { TextTransparency = 0.6 }):Play()
end

-- Input -----------------------------------------------------------------------
local function onInteract(_: string, state: Enum.UserInputState)
	if state ~= Enum.UserInputState.Begin then
		return Enum.ContextActionResult.Pass
	end
	flash("Interact pressed")
	if RemoteBus then
		RemoteBus.Fire("Interact")
	end
	return Enum.ContextActionResult.Sink
end

ContextActionService:BindAction("Interact", onInteract, true, Enum.KeyCode.E, Enum.KeyCode.ButtonX)
ContextActionService:SetTitle("Interact", "Use")
ContextActionService:SetPosition("Interact", UDim2.fromScale(0.72, 0.2))

-- Character lifecycle ---------------------------------------------------------
local function onCharacter(character: Model)
	local humanoid = character:WaitForChild("Humanoid") :: Humanoid
	flash(("Spawned - %d HP"):format(humanoid.MaxHealth))
	humanoid.Died:Once(function()
		flash("You died")
	end)
end

if player.Character then
	task.spawn(onCharacter, player.Character)
end
player.CharacterAdded:Connect(onCharacter)

-- Server pushes ---------------------------------------------------------------
if RemoteBus then
	RemoteBus.OnClientEvent("Notify", function(message: string)
		flash(tostring(message))
	end)
end
